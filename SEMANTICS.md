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
`charCodeAt`/`split("")`/`isWellFormed`/`toWellFormed`, and the wasm
casing unit test pins it through `toLowerCase`/`toUpperCase` (a corpus
program cannot cover this — the native lanes
still carry upstream's U+FFFD substitution, so the removal is observable
on the wasm tier only). The `toLowerCase`/`toUpperCase` case is Node-
matching, not a divergence in itself (Node's own case conversion is also
identity on a lone surrogate) — it rides this entry as an editorial
addition to the tested-by list, not a new semantic claim.

## S003 — Out-of-bounds array reads throw `RangeError` *(inherited)*

Arrays are dense; `a[i]` with `i` outside `[0, length)` throws `RangeError`
instead of returning `undefined`. This is the static tier's largest deliberate
semantic divergence from JS and the price of unboxed typed arrays.
**Rationale:** returning `undefined` would force every element type to be
`T | undefined`. **Tested by:** diagnostics fixtures + corpus programs using
`@exit:` lanes (cannot be differential-tested against Node by definition).

**Amendment (increment 18, typed arrays):** the SAME discipline covers typed-
array/Buffer element access. JS typed arrays read `undefined`/silently ignore
a write outside `[0, length)`; neither is representable here (an unboxed f64
read has no `undefined`, and a silently-ignored write is not a value at all),
so `get`/the `bytesSet` statement TRAP on any out-of-bounds or non-integer
index — an UNCATCHABLE abort on every tier that implements it, exactly S003's
own stance and the same S007 exit-1 bridge on the wasm tier (the may-throw
analysis counts runtime traps as aborts, so no pending check ever observes
one). Unlike plain arrays, no corpus program can pin this for typed arrays
either (a differential comparison against Node's `undefined`-returning read
would fail by construction): the wasm emitter unit test covers it instead
(OOB read, OOB write, and a non-integer index, per S003's own "cannot be
differential-tested" note). **Tested by:** the wasm emitter unit test.

**FORWARD POINTER (added at INC-24's own close-out, rev-24's own gate finding on the P6 freeze):**
two further amendments to THIS entry — a regex VALUE reaching a lastIndex-consulting method with a
stateful GLOBAL/STICKY flag (increment 24 P4) and the assert surface reaching the same class
through four new sites (increment 24 P6) — are filed roughly 5,000 lines below, immediately after
S067's own "Board #119" line, not here. They are S003's own by content (both amendments cite this
entry explicitly) but sit in S067's own document position by structure, unlike every other
amendment in this file, which lives inside its own entry. That placement is PRE-EXISTING from P4
(P6 simply followed it) and is left as-is here — relocating ~5,000 lines of content carries more
risk than the reader problem it would solve — but a reader arriving at S003 looking for the
class-wide value-path regex trap should search this file for "Amendment (increment 24" rather than
assume this entry's own text above is the complete account. **Board #301 retired both** (filed right
after them: "Amendment (board #301)"): a regex value's lastIndex is modelled on every lane, and only
`assert.throws`'s shape form still refuses a value-path g/y regex at run time.

## S004 — Node platform APIs are refused, not emulated

The static tier compiles the language and core stdlib (`Math`, `String`,
`Array`, `Map`/`Set`, `JSON`, `console.log`, `Promise`). Node platform
surfaces (`fs`, `net`, `http`, `child_process`, `process.*` beyond a minimal
subset, …) are **refused at compile time with a named diagnostic** — never
stubbed, never silently absent at runtime. Host capabilities enter a tsinter
module only through its declared imports. Since INC-28 U1, child_process's
synchronous surface (`spawnSync`, `execSync`, `execFileSync` and promisified
`execFile`) enters the wasm tier only through the `tsinter.cpCall` import, which a
host may decline to provide (the module then fails to instantiate with a
LinkError); since INC-28 U2 so does `spawn`'s asynchronous surface (the
ChildProcess value, its `'exit'` and `'error'` events, `kill` and `unref`),
through `tsinter.cpCall` and `tsinter.evPoll`, with the same LinkError when a
host declines either; the sandbox rationale stands for every other
child_process surface. Since INC-29 U1, node:net's TCP surface (`net.Server`
and `net.Socket`: listen, connect, the stream's reads and writes, end,
destroy, close) enters the wasm tier only through the `tsinter.netCall`
import — OS-level operations only (bind and listen, connect, start and stop
reading, write bytes, shut down, close, TCP_NODELAY, getaddrinfo), every Node
behaviour built in the module — and `tsinter.evPoll`, with the same LinkError
when a host declines either. Since unit G1, process signal listeners
(`process.on` / `once` / `off` / `removeListener` for `"SIGINT"` and
`"SIGTERM"`, refused by INC-26 P3 until a host signal channel existed) enter
only through the `tsinter.sigCall` import — subscribe and unsubscribe a
signal number, libuv's uv_signal_start / uv_signal_stop — and
`tsinter.evPoll`; a host that cannot catch signals (a browser) declines it
and the module fails to instantiate with a LinkError. Since unit G3,
`fs.watch` and `FSWatcher.close` enter only through the `tsinter.watchCall`
import — start and stop a file-system event watch on one path, libuv's
uv_fs_event_start / uv_fs_event_stop, failures in fsCall's error carrier —
and `tsinter.evPoll`, with the same LinkError when a host without
file-system notifications (a browser) declines it. Since unit G2,
process.stdin's events and its for-await chunk source, and node:readline's
question / close slice, read fd 0 only through the `tsinter.stdinCall`
import — start and stop reading, libuv's uv_read_start / uv_read_stop — and
`tsinter.evPoll`; a host with no standard input may answer end-of-file at
once, and one that declines the import fails the module's instantiation
with a LinkError (SEMANTICS.md S097 registers what differs from Node). Since #227, the global `fetch()` enters the wasm
tier only through the `tsinter.fetch` import — the host's own fetch, asked
for plain data (S098) — and `tsinter.evPoll`, with the same LinkError when a
host declines either; a module that reaches only the AbortSignal statics
imports neither. Since S113, the host's local time zone enters only through
the `tsinter.tzCall` import (an offset at an instant, a zone name, and the
program's own TZ writes), with the same LinkError when a host declines it.
**Rationale:** the output is a
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

*(Amended increment 22 stage C, gate fix C5: the trap used to be bare —
zero stderr for ANY uncaught exception, JS-lane compile fences (a
`runtimeFence` IR node — see lower-stmts.ts's per-statement PoisonError
catch) included. That made a fenced-but-otherwise-valid construct like a
per-write stream callback with the wrong arity, or even a plain
`debugger;` statement, compile clean and then die with NO indication why
— worse than a compile-time refusal, and a real "never miscompile,
never fall back silently" gap even though the harness could never see it
(stderr is skipped on nonzero exit — see below). `_start`/`_tick`/the
process.nextTick drain now call ONE shared reporter
(`%w.err.reportUncaught`, emitter.ts) before they trap — S010's own
"print the reason, then trap" shape, ported to the throw side. What
changed and what didn't:*

An exception that unwinds out of `%main` is uncaught: `_start` tests the
pending cell, prints `"Uncaught " + <cell rendered like S010's rejection
reason>` to fd 2 (a number through ToString, a bool as `true`/`false`, a
string raw, an Error-shaped object as `name: message` via the SAME
renderer S010's `errToStr` and the native tier's own uncaught printer
already use, anything else as `[object Object]`/`[object]`), and THEN
traps — which the harness bridge reports as exit code 1, Node's
uncaught-exception exit. Node's own stderr instead carries a full stack
trace, so stderr still diverges (stack traces are still not captured;
this only closes the gap between the wasm tier and the native tier's own
uncaught printer, which already wrote this same "name: message" shape —
they render alike now instead of wasm alone staying silent). The same
holds for an exception out of a MACROTASK callback (`_tick` tests the
cell after every timer and every immediate callback and reports-then-
traps there, and a repeating interval whose callback threw does not
re-arm — the process is already dead, exactly as it is in Node) and for
one out of a `process.nextTick` callback (the drain loop's identical
per-entry check). **Rationale:** the artifact ABI has no exit-code
channel; the trap IS the nonzero exit — printing first costs nothing
the differential suite can see (the harness skips the stderr compare on
a nonzero exit, unchanged) but stops a fenced construct from dying
silent. **Tested by:** corpus uncaught-throw programs and
`1442-interval-throw` (stdout before the throw plus exit code must match
Node; the harness skips the stderr compare for nonzero-exit programs);
the wasm emitter unit test pins the evaluation-order-then-trap case and
now also its printed report; the wasm timers unit test the
interval-callback one; the wasm nexttick unit test pins the
`process.nextTick` death-check's identical report and a same-shape
double-print sweep across all three uncaught sites plus S010's rejection
path (never more than one labeled line each).

**Amendment (increment 23 P3, `queueMicrotask`):** a FOURTH site reaches
this SAME "report, then trap" reporter — a queued microtask's own
callback throwing uncaught. `%w.async.mtResume` (the shared resume
closure `timers.queueMicrotask`'s own frame-subtype design mints —
design note in FINDINGS) checks the pending cell immediately after
calling the user's closure and, on a throw, calls `%w.err.
reportUncaught` directly — the SAME reporter, the SAME "Uncaught " +
rendered-reason text, never through `_tick`'s own per-callback check
(a queueMicrotask-only program has no `_tick` at all — its OWN drain
runs once from `_start`). Node's real behavior matches exactly: an
uncaught throw from inside a microtask callback crashes the process
the same as any other uncaught exception. **Tested by:** `packages/
compiler/test/wasm-queuemicrotask.test.ts`'s throw-inside-microtask
pin (exit code + stderr byte-exact, via `runWasmToTrap` — the harness
skips the stderr compare on nonzero exit, unchanged); mutation-
confirmed (own hand-verification, reverted, hash equal before/after):
routing the pending check to a dead condition reddens that pin by
name.

## S008 — Wasm tier: string `repeat`/`pad`/`join` past the length limit trap

`String.prototype.repeat` with a negative or infinite count traps (the
spec's RangeError through the S003 bridge, exit 1 like Node). The SIZE
limit is Node's own — V8's String::kMaxLength, 0x1fffffe8 (2^29 − 24)
UTF-16 units — but the failure mode differs: a `repeat`, `padStart`/
`padEnd` or `Array.prototype.join` result past it traps (checked before
anything is allocated), where Node throws a catchable `RangeError:
Invalid string length`. **Rationale:** native parity — the C runtime's
`scr_str_repeat` aborts through `scr_trap` on the same conditions (an
UNCATCHABLE termination where Node throws a catchable RangeError; the
may-throw analysis counts runtime traps as aborts on every tier); real
programs at the threshold are allocating a gigabyte of string either way.
Concatenation is NOT in this entry: `+`, `+=` and template literals throw
Node's catchable RangeError at exactly the same limit on this tier
(strings unit S2 — a concatenation node makes a string past the limit
cheap to describe, so the check sits where the concatenation is built,
and a function containing one counts as may-throw).
*Amended (strings unit S2):* the cap was 2^31 units for `repeat`/`pad`
and absent for `join`; it is now Node's threshold for all three.
**Tested by:** packages/compiler/test/wasm-string-length-limit.test.ts —
`repeat` and `padStart` one past the limit trap; concatenation's
catchable RangeError and exactly-the-limit acceptance match Node.

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

**Amendment (increment 17, index-signature records):** the SAME
trust-but-verify mechanism covers a second site — a dynamic-keyed write
`r[k] = v` on a hybrid (index-signature) record shape, when the runtime key
`k` happens to name a DECLARED field whose static type is narrower than the
index signature's `unknown`/`dyn` value type `v` arrives as. Node just
stores whatever `v` is (`r.known = "not a number"` works). Here the write
validates `v` against the declared field's type through the identical
dynCheck machinery `e as C` uses, and a mismatch throws the catchable
`TypeError: expected <type> at $.<field>, got <type>` with the field left
untouched, instead of corrupting a monomorphic struct slot with a value of
the wrong representation. Measured on Node 24.18 against the C lane: given
`interface Mixed { known: number; [k: string]: unknown }` and
`function setKey(r: Mixed, k: string, v: unknown) { r[k] = v; }`,
`setKey(r, "known", "not a number")` runs silently on Node (`r.known`
becomes the string `"not a number"`) and throws
`expected number at $.known, got string` here (C and wasm agree
byte-for-byte), leaving `r.known` at its prior value. **Tested by:** the
wasm emitter unit test; the C/LLVM lanes have exercised this exact dynCheck
path since index-signature records first shipped there, so this note
documents the wasm tier joining an ALREADY-registered divergence rather
than opening a new one.

**Amendment (increment 21 stage B, island exit):** on the wasm tier, an
island (jsval) value crossing the `jsExit` boundary into a declared
static COMPOSITE type — record, array-of-non-jsval, `bytes<u8>`,
undefined-armed union — validates via the SAME dynCheckHelper this
entry's body and the increment-17 amendment above already cover:
width-tolerant records, path-annotated failures ("expected <type> at
$.<field>, got <type>"), the undefined arm for missing optionals. Node
erases TS types entirely, so no oracle exists for the check itself; the
reference LLVM lane produces byte-identical output for the same source
(measured directly). The primitive-target exits (strict tag-read, no
coercion) landed in stage A. **Tested by:** the increment-21 unit pins
(happy and failing composite exits diffed against the compiled C
reference).

**Amendment (increment 23 P3, `++`/`--` on a checked-dynamic field):** a
THIRD site reaches the SAME dynCheck-validates-instead-of-erasing
mechanism — `expr:fieldIncDec:dyn` (`obj.field++`/`--obj.field`/the
symbol-keyed spelling `--this[kSym]`, both prefix and postfix) over a
class field whose declared type is `unknown` (a "CHECKED-DYNAMIC"
field: an implicit-any assignment in a plain JS constructor —
`isJsSourceFile`-gated; a TS file with an explicit `unknown` field
type does not reach this arm). Real JS `++`/`--` NEVER throws on a
non-number operand — it performs `ToNumber()` coercion silently
(`"abc"++` evaluates to `NaN`, no throw, in real Node); this tier
instead dynChecks the number OUT of the field (the identical
`dynCheckHelper`/root-path/`emitPendingCheck` machinery the entry's
body and both prior amendments already use), computes `±1`, and boxes
the result back — a catchable `TypeError` on a non-number, never a
silent `NaN`. Measured (own construction, node v24.18.1 vs this tier,
byte-identical message shape to the two existing amendments):

    class C { constructor(n) { this.n = n; } inc() { return this.n++; } }
    const c = new C('abc');
    try { c.inc(); } catch (e) { /* this tier: TypeError, "expected number at $, got string" */ }

Node's own `c.inc()` above returns `NaN` silently and never throws —
this is NOT a Node divergence being matched; it is this tier's OWN
established checked-dynamic boundary stance, extended to a third
reachable site. **Tested by:** the wasm emitter/corpus pins in
`packages/compiler/test/wasm-fieldincdec.test.ts` — prefix/postfix
`++`/`--`, the non-number `TypeError` arm (confirmed `instanceof
TypeError`, message byte-identical to the entry's own established
format), and corpus 1710 (claimed, runs) and 1730 (the symbol-keyed
spelling, `countdown.js` verbatim, COMPILES — its own first refusal
moved off `expr:fieldIncDec:dyn` onto `libCall:sym.new`, so `--this
[kLimit]` is confirmed to compile clean, not confirmed to run; 1730 is
not claimed by this rider). Mutation-confirmed (own hand-verification,
reverted, hash of `emitter.ts` equal before/after): breaking the `±1`
arithmetic or skipping the box-back step reddens the arithmetic pin by
name.

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

A REJECTED TOP-LEVEL-AWAIT ROOT reports through the same channel. The
module evaluation promise of a program using top-level await is
loader-owned — marked observed the moment it exists, so the ledger walk
above never answers for it — and its rejection is instead decided by the
checkpoint that observed it: the same `Unhandled promise rejection:
<reason>` line to fd 2, then the same trap, which stops the event loop
before any timer already armed can fire (Node terminates there too, so a
later timer is dead code on both sides — corpus 2653). Node's own stderr
carries the error and a stack trace, and for an unrelated rejection raised
in the SAME checkpoint Node reports the module error while this tier's
ledger walk runs first and reports the other one; both are exit 1 with the
same stdout, and the line they disagree over is stderr on a nonzero exit.
**Tested by:** corpus 2648/2651/2653 (stdout and exit code) and the wasm
top-level-await unit test (the stderr line, the trap, and the timer that
never runs).

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

## S012 — Wasm tier: an unsettled top-level await exits 13 without Node's warning

A program whose module evaluation promise is still PENDING when the event
loop runs dry exits 13 — Node's dedicated unsettled-top-level-await status
— which this tier answers through the `_status` export (abi.ts) rather
than a trap: the artifact has no exit-code channel, and 13 is not the
trap's 1. The DIVERGENCE is stderr: Node additionally writes a `Warning:
Detected unsettled top-level await at <file>:<line>` report naming the
await that never resumed, and this tier writes nothing at all. The loop is
not cut short by the pending root either way — timers already armed still
run to quiescence, and the verdict is taken after them. **Rationale:**
source locations are not carried into the artifact (the same reason S007
and S010 have no stack traces), so the warning could only be approximated;
the exit code, which is what a caller branches on, is exact. **Tested by:**
corpus `2649-top-level-await-pending` and
`2651-top-level-await-pending-unhandled` (the exit code, with the stderr
compare skipped for nonzero exits) plus the wasm top-level-await unit test
(exit 13 with the armed timer's output intact).

## S013 — `JSON.parse` caps nesting depth at 1000 *(inherited)*

A JSON document nested more than 1000 levels deep throws a catchable
`RangeError` reading `Maximum call stack size exceeded` instead of
parsing. This diverges on EVERY lane — the C runtime's parser
(`SCR_JSON_MAX_DEPTH`, scr_json.c), the LLVM lane that links it, and the
emitted wasm parser all carry the same cap — and it is new to none of
them: Node has NO depth limit, because V8's JSON parser is iterative and
nesting is bounded only by memory (100,000 levels parse fine there), so
every lane has diverged past the cap for as long as the cap has existed.
**Rationale:** all three parsers are recursive descent, where unbounded
recursion smashes the native stack (or exhausts the wasm one); a
predictable catchable `RangeError` at a documented depth is a better
failure than an unpredictable stack-exhaustion abort. The message is the
one V8 produces when a *recursive* JS reviver blows the stack, which is
the nearest true thing to say. The error is CATCHABLE through the
exception cell on every lane (`scr_throw_error` natively) — deliberately
NOT a member of the uncatchable-trap family S003/S006/S008, which exists
for checks the may-throw analysis counts as aborts. Removing the
divergence means an iterative parser with an explicit value stack on
every lane. **Tested by:** the wasm emitter unit test — 1000 levels
parse, 1001 throws — which is the FIRST pin this boundary has ever had;
the native lanes carry no corpus or unit coverage for it (pre-existing
untested behavior), and no corpus program goes near the depth.

## S014 — Crossing the `unknown` boundary COPIES; mutations do not propagate *(inherited)*

Converting a typed composite into an `unknown` value DEEP-COPIES it, and
validating one back out with `as T` copies again — so a record, array or
tuple that has crossed the boundary shares no storage with its source.
Mutating the original after the conversion is invisible to the extracted
value, and mutating the extracted value is invisible to the original.
Node's casts are erased and hand back the SAME object, so a program that
mutates across the boundary observes the change there and does not here.
This is not a wasm-tier fact: the C runtime, the LLVM lane that links it,
and the emitted wasm walkers all copy, and all three print the same
answers. **Rationale:** inherited from the C runtime's ownership design —
a `ScrDyn` OWNS its tree, so aliasing static storage would break the
refcount discipline on the native lanes (a dyn value outliving the record
it borrowed from). The wasm representation carries no such constraint —
aliasing would be perfectly representable there (the payload slot could
point at a static array's vec struct today) and simply WRONG, because it
would disagree with the native lanes; cross-lane agreement, not the
representation, is what forbids it. The copy is also what
makes the boundary's two directions symmetric: `dynCheck` must build a
typed value it can hand out, and it has nothing to alias if the source
was itself parsed. Distinct from S009, which is about a lying cast being
CHECKED rather than erased; this is about a truthful one still not
sharing. **Tested by:** the wasm emitter unit test only. No corpus
program can pin it, and not merely because the lanes agree — a program
whose output depended on the aliasing would diverge from Node and fail
the differential by construction, so the corpus can only contain
programs that never look.

**Amendment (increment 18 stage C, dyn crossing): `bytes<u8>` (Uint8Array/
Buffer) is a REGISTERED EXCEPTION — on the wasm tier only, crossing
`unknown` ALIASES, matching Node, not S014's body.** Measured directly
(Node 24.18), three independent shapes, all agreeing: a Buffer/typed
array crossing into an untyped (`any`/`unknown`) boundary and mutated
from that side is observed as the SAME mutation from the originally-typed
side — `function f(x){x[0]=99} const b=Buffer.alloc(4); f(b);` sees `99`
back through `b`; the same holds crossing via an object property write
and via array storage. Node's `unknown` is erased, not boxed, so this is
just ordinary JS reference semantics, not anything buffer-specific — but
it is the semantics, and S014's own body already grants that Node
disagrees with the copy rule ("Node's casts are erased and hand back the
SAME object... a program that mutates across the boundary observes the
change there and does not here"). For bytes specifically, this tier now
matches Node instead of accepting that gap.

**Why the exception is sound and extends to nothing else.** S014's
rationale is NOT "aliasing would be expensive" — it is that the wasm
lane's representation must agree with the C/LLVM lanes, which structurally
CANNOT alias (a `ScrDyn` owns its tree under refcounting; aliasing static
storage would let a dyn value outlive what it borrowed from). That
constraint is real and unchanged for every OTHER composite kind — records,
arrays, tuples — which is exactly why they keep copying under this
amendment too. Bytes is different in the one property that matters here:
a `$bytes` struct is ACYCLIC BY CONSTRUCTION. It holds only raw storage
bytes (an `array (mut i8)`, an offset, a length) — no field of it can ever
point at a dyn box, a record, or anything else that could point back. The
cycle-safety argument S014's copy rule protects (a record aliased into
`unknown` could, if the language let it, produce a reference cycle through
the boundary that the inspect walker's seen-stack machinery — S029 — has
to detect) simply does not apply to a value that can never carry a
reference in the first place. The exception costs the cycle-detection
story nothing because there is no cycle it could ever need to detect.

**The per-lane split is deliberate, not an oversight.** The C runtime and
the LLVM lane that links it are TRANSITIONAL — AGENTS.md's own framing:
"kept as executable semantics references until the wasm lane stands
alone" — so they keep copying bytes across the boundary exactly as S014's
body describes (board #23 — closed at increment 18 — recorded this as their
own, explicitly-accepted divergence from Node, not a bug to fix on
those lanes). The wasm
lane, this project's future-primary target, boxes the SAME `$bytes` ref
instead: `dynFrom` on a bytes value stores the existing struct reference
directly, never a copy; `dynMatch`/`dynCheck` extraction hands back that
SAME reference, not a fresh one — both directions alias, because Node's
semantics have no one-directional copy to model. Locking the future-
primary lane to a Node divergence whose only reason to exist is agreement
with lanes this project intends to retire would invert the project's own
stated direction; the acyclic argument above is what makes it safe to
stop doing that for exactly this one payload kind.

**The symmetry path, and why it is vacuous for bytes today.** S014's body
names a second load-bearing property beside cross-lane agreement:
boundary symmetry — "`dynCheck` must build a typed value it can hand out,
and it has nothing to alias if the source was itself parsed." For every
OTHER composite kind that sentence is live: a record extracted from a
`JSON.parse` result was never a typed value to begin with, so `dynCheck`
has no static storage to point at and must materialize one. Aliasing
would need that same materialization fallback for bytes if a parsed dyn
source could ever carry `DK.BYTES` — and it cannot, measured structurally
rather than assumed: `boxBytes` (dyn.ts) is the ONLY constructor of a
`DK.BYTES` box anywhere in the wasm backend, and it has exactly ONE call
site — the `dynFrom` producer arm (`emitDynFromBody`'s `case "bytes":`,
emitter.ts). JSON's grammar has no bytes/buffer literal, so the parser
(json.ts) never calls it; nothing else in the tree constructs a `$dyn`
box with kind `BYTES` either. Every `DK.BYTES` value that can exist,
without exception, therefore already carries a real `$bytes` struct
`dynFrom` boxed directly — `dynCheck`'s extraction always has something
to alias, so the "nothing to alias" branch of S014's symmetry argument is
UNREACHABLE for this one payload kind, not silently unhandled. This is
not a permanent structural fact — a future dyn-producing construct could
in principle synthesize bytes some other way — so this paragraph is the
record of why today's amendment does not need a materialize-on-extract
fallback, not a claim that one could never become necessary.

**Corpus-unpinnable, same as S014's own convention, while the native
lanes still live.** A program whose output depends on aliasing bytes
across `unknown` diverges between lanes (wasm aliases, C/LLVM copy) and
so cannot be a corpus program without breaking cross-lane agreement on
some OTHER lane — the identical shape as S014's own "the corpus can only
contain programs that never look." This is unit-pinned instead:
`wasm-emitter.test.ts` asserts a byte written through the `unknown`-typed
side is observed through the original typed side and vice versa, and
that a value crossing `unknown` TWICE is `===` through `unknown` both
times (dyn-space strict equality for `DK.BYTES` compares the PAYLOAD
`$bytes` ref via `ref.eq`, never the `$dyn` box that wraps it — the
increment-16 box-copying lesson, applied here so two independent crossings
of the SAME source correctly identity-match exactly as Node's erased cast
does). The island marshal direction reaches the same crossing through a
second caller (increment 21 stage B: `jsMarshal` of a `bytes<u8>`-typed
static value into an `any` slot routes through the identical dynFrom
bytes arm) and takes the identical stance: wasm ALIASES, matching Node;
the native island copies (`scr_jsval_from_bytes`). Same split, same
rationale, no new entry.

**Amendment (increment 21 stage A, island crossing): on the wasm tier,
`jsMarshal` of a BARE `dyn`-typed OPERAND ALIASES rather than
deep-copying — a SECOND registered exception to this entry's body,
alongside bytes<u8>, and narrower: one jsMarshal source-type arm only.**
Under the wasm backend's representation decision (jsval ≡ dyn:
`mapType(jsval)` answers the identical `(ref null $dyn)` that
`mapType(dyn)` does — there is no embedded engine on this tier, so an
island value is an ordinary dyn payload from birth, never a wrapped
handle), `jsMarshal` of a `dyn`-typed source is representationally the
value already on hand. The native lanes deep-copy at this boundary (a
`ScrJsval` is a distinct heap object from the `ScrDyn` it was built
from); the wasm lane has nothing to copy FROM — source and "marshaled"
result are the same wasm value. RECORD AND ARRAY COMPOSITES ARE NOT
COVERED: a record/array whose own static type is record/array reuses
`dynFromHelper`'s per-typeKey walker, a real deep copy, unchanged, on
every lane — and that copy is now OBSERVABLE through identity on the
island surface (measured: a record marshaled into two `any` slots
compares `===` FALSE on wasm and C alike, TRUE on Node — both lanes
agree, so it is this entry's own corpus-unpinnable shape, recorded so
the next reader need not re-derive it).

Why the exception is sound and extends to nothing else: unlike the
bytes amendment (safe because `$bytes` is acyclic by construction),
this arm is safe for a stronger reason — it introduces no NEW aliasing
relationship at all; nothing points at anything it did not already
point at, because there is no crossing at the representation level,
only at the type system's bookkeeping. Cycle-safety is the same
structural argument (labelled structural, not measured — no test
constructs a cyclic dyn-into-island value): aliasing can only carry a
cycle that already existed on the dyn side, and under identity
representation there ARE no island-specific walker entry points that
could skip a cycle guard — a jsval-reached inspect/stringify/dynCheck
IS the plain-dyn entry point (S026's depth cap, S029's seen-stack),
which already owns those cycles today.

The arm is corpus-EXERCISED, not merely argued: four of stage A's
claimed programs construct it (2579 ×1, 2583 ×4, 2585 ×4, 2632 ×6 —
instrumented) and pass the byte-for-byte differential; the
identity-vs-copy distinction is unit-pinned in wasm-emitter.test.ts
("jsMarshal(dyn) aliasing": marshaled twice from one local, `===` both
times on wasm matching Node, with the C lane's `false` pinned beside it
so the per-lane split cannot be silently "fixed" toward the copying
side). The reverse direction (dynFromJsval, identity by construction)
has its own pin.

**Amendment (unit P): `any[]` — an array whose elements are island
values — is a THIRD registered exception on the wasm tier, along the
paths listed here and no others.** The two exceptions above each say
they extend to nothing else; this one is named, not inherited. Its
representation argument is the jsMarshal(dyn) arm's: an `any[]`'s
vector IS an island array's payload vector (vecKeyFor interns
array<jsval> as the dyn ARR payload's own type), so no crossing happens
at the representation level and no new aliasing relationship can form —
the elements were island values already. These paths ALIAS on wasm
(Node's answer; the native lanes copy the spine, S044):
- the checked exits into an `any[]` slot — jsExit's array<jsval> arm,
  the array arm of a checked union exit (an `any[] | undefined`
  parameter, `dynCheck`), and the async-return adoption cast
  (`%w.isl.exit:arr`) (P-PARAM-01);
- a static `any[]` boxed back into a dynamic value by `dynFromHelper` —
  a static `Promise<any[]>`'s fulfilment as an island reader sees it,
  and a jsMarshal of an `any[]` (P-HELD-01); dyn `===` on arrays
  compares the payload vectors, so two boxes of one vector are one
  array;
- the `Promise<any[]>` bridge's fulfilment (S044).
These paths still COPY, on every lane: the front end's own `any[]` →
`any` lift (`%jsin.arr`, and `%jsin.rec` for records) that an
assignment into an `any` local, an object-literal member and a property
write go through — `const anyR: any = r`, `h.a = a`, `pass(a) === a` —
so a static `any[]` written into the island is a fresh array per write
(P-LIFT-01, P-LIFT-02; Node shares it). Board #259 tracks that lift.
Every other composite kind keeps this entry's body.

**Amendment (unit H, boards #259/#268, Joe's ruling D2 2026-10-26):
`any[]` IS the island array, on every lane; the unit-P alias/copy lists
above are retired.** The type mapping no longer carves out literal
`any[]`: an array whose element is an island value (`any[]`,
`Array<any>`, `any[][]`, a package's `GeneratedFile[]`), a record or
tuple with an `any`-typed member (`{ items: any[]; name: string }`), and
`Record<string, any>` all map to the island value itself (`jsval`) — one
engine array/object, every operation on it an engine operation — where
`any[]` used to be a STATIC array of island handles. With one
representation there is nothing to copy, so every crossing the lists
above named — the front end's `%jsin.arr`/`%jsin.rec` lift through an
`any` local, an object-literal member and a property write; a typed
`any[]` (or `any[] | undefined`, or defaulted) parameter receiving an
island array; a returned `any[]`; empty-array identity (board #268); a
`Promise<any[]>` fulfilment, which now arrives as it is, array or not —
SHARES one array on wasm, c and llvm, as in Node: a push through either
side is seen through the other and `===` holds. S044's native spine copy
no longer arises for `any[]` slots (no exit runs). Rest parameters typed
`any[]` bind a fresh engine array per call (the JS `(...args)` island
form). TYPED composites (`string[]`, `number[]`, records and tuples of
static data) are S115's subject: they enter the island as live VIEWS of
the static value (shared, as in Node) and leave it only when fresh —
every other exit refuses at compile time.
**Tested by:** `packages/compiler/test/wasm-any-array-shared.test.ts`
(H-SHARE-01..04 — the review's a01/a02/a04/b04 repros — H-METHODS-01,
H-INSPECT-01, H-CORPUS-2787), P-LIFT-01/02, P-PARAM-01, P-BRIDGE-01/13,
P-ASYNC-03, P-IDENT-01 (now Node's answers), the increment-21 jsExit pins
in `wasm-emitter.test.ts` (the C lane now shares too), and corpus 2787
on every lane.

## S015 — Keyed reads and `in` on `unknown` see OWN properties only *(inherited)*

`u[k]` on a checked-dynamic value answers the receiver's OWN member, or
`undefined` when it has none. Node consults the prototype chain, so
`JSON.parse('{}')["toString"]` is a real function there and `undefined`
here; the same holds for every inherited member of Object, Array and
String (`hasOwnProperty`, `valueOf`, `slice` as a VALUE rather than a
call, ...). The PRESENCE operator answers the same way for the same
reason — `"toString" in u` is `true` in Node and `false` here, as is
`"slice" in u` on a dyn array — because there is no chain to walk, only
the own-entry table the read consults. The same holds for the class
prototype of an untyped JavaScript `new Map()`, `new WeakMap()` or
`new WeakSet()`, which the wasm tier builds as a dyn object tagged with its
class (board #218): `typeof m.get` is `"undefined"`, `"size" in m` is
`false`, `m.constructor === Map` is `false`, and `m.size` read into a typed
slot is the checked read's TypeError, while conversion, inspection,
cloning, deep equality and iteration answer as the class. (`Object.hasOwn` is own-only by
definition, so it agrees with Node wherever the member genuinely exists,
string receivers included; it parts company only where S016's padding
invents members Node left as holes.) The named forms that DO work are
the ones the runtime models directly: `length` on arrays and strings,
canonical index reads, and prototype METHOD CALLS, which dispatch on the
receiver's kind rather than reading a member (S023's surface). On the wasm
tier those calls include Object.prototype's own (board #191):
`hasOwnProperty`, `propertyIsEnumerable`, `isPrototypeOf` and `valueOf` on
every non-nullish receiver, and `toLocaleString` on an object, answer as in
Node — `JSON.parse('{"a":1}').hasOwnProperty("a")` is `true` — while an own
member of the same name still shadows them and a null-prototype object has
none; the c and llvm lanes still throw "is not a function" there. `toLocaleString`
answers the object's ToString conversion, which on the tree ignores an own
`toString` member (`o.toString = () => "X"` still gives "[object Object]",
the same answer `String(o)` gives). On the wasm tier one shape does have a
chain (unit A2): an island object built by `Object.create(proto)` reads,
calls methods and answers `in` through its prototype objects, live, as in
Node — its conversion still ignores a `toString` member, own or inherited,
the same way. (The ARITHMETIC and RELATIONAL operators on an island value
are not this conversion: they run ToPrimitive over the object's
`valueOf` and `toString` — own, else through the prototype link, a
function's own too — on every lane: S104, board #251.) **Rationale:** inherited
from the C runtime's dyn tree, which stores own entries and has no
prototype chain; giving it one means materializing Object/Array/String
prototypes as real function values on every lane, which is a feature
rather than a fix, and the runtime's design deliberately routes method
CALLS through kind dispatch instead. The divergence is only observable
when a prototype member is read as a VALUE or asked for by name, which is
rare in the corpus and absent from it entirely. **Tested by:** the wasm
emitter unit test — no corpus program can pin it, because a program whose
output observed the divergence would fail the differential by
construction; the test pins tsinter's answer (`undefined`, and `false`
for the presence form) with Node's in a comment.

## S016 — Keyed writes on `unknown`: what the dyn tree cannot store *(inherited)*

The checked-dynamic tree stores objects as an own-entry table and arrays
as a DENSE vector, with no expando map beside either and no hole bit
inside the vector. Five observable consequences follow from THAT shape —
three loud, and two that say nothing at all. What is exact first, so the
boundary is clear: object writes (insertion order, later writes winning,
the surviving entry keeping its original key), array index writes within
the allocatable range (`length` and every read match Node), the
refusals on nullish, number and boolean receivers (V8's own texts
character for character), and — since increment 23 P4 (board #98,
Amendment below) — keyed writes on a boxed FUNCTION, which now succeed
through a side property table keyed on closure identity rather than
being a member of this entry's own array/object storage shape at all.

**Amendment (increment 23 P4, board #98) — the FUNC-write arm is
RETIRED; the remaining arms are unchanged.** `Object.defineProperties`
gave a boxed function its own property table (dyn.ts, the `$fnProps`
side structure keyed on `FN_CLOS`, one entry per closure identity — NOT
per box, since `===` and the property table must agree and a box does
not survive S014's copy-on-crossing); `f.x = 1` was wired into the SAME
table (an ordinary keyed write creates an ENUMERABLE property, Node's
own default), which is what actually retires this arm rather than
merely giving it a narrower write path. MEASURED, byte-exact against
Node: `function g(){} g.x = 1; console.log(g)` now answers
`[Function: g] { x: 1 }` on both, where before this round the wasm tier
threw. This is a CLEAN retirement, not a partial one — the write
succeeds, the value reads back through every surface (`f.x`, `hasOwn`,
`Object.keys`, both inspect renderers), exactly matching Node's own
default-enumerable, default-writable, default-configurable shape for an
ordinary assignment. The four OTHER consequences below (object/array
padding, non-index array writes, string receivers) are UNCHANGED —
board #98 touched the FUNC receiver only.

**Padded slots are OWN PROPERTIES, where Node leaves HOLES.** Growing a
dyn array by index fills the gap with real `undefined` members instead of
a sparse region: after `a[3] = 9` on `JSON.parse('[1]')`, both answer
`length === 4` and both read `a[1]` as `undefined`, but `Object.keys`
answers `["0","1","2","3"]` here and `["0","3"]` in Node, and `'1' in a`
and `Object.hasOwn(a, '1')` answer `true` here and `false` there. Values
and entries follow keys. This is the SILENT one — nothing throws, the
program simply enumerates members Node never created.

The index write is not the only route to a padded slot. `map` binds its
output to the length it captured before the first step (the spec's own
shape), so a callback that SHRINKS the receiver leaves the steps it
skipped holding `undefined` where Node leaves holes: `a.map(cb)` on
`JSON.parse('[1,2,3,4]')` with a `cb` that pops twice answers
`length === 4`, `join` `"2,4,,"` and `r[2]` `undefined` on both, and
parts company only at `Object.keys` — `["0","1","2","3"]` here,
`["0","1"]` in Node. Same storage fact, same silence.

**A non-index key throws where Node writes.** `a['nope'] = 1` raises a
catchable "Cannot create property 'nope' on array" (V8's strict-mode
primitive-write shape with the array kind name substituted) where Node
adds the property and reads it back. `length` is the same throw and the
more common shape: `a['length'] = 1` truncates a three-element array in
Node and throws here.

**String receivers get the wrong V8 text for the read-only cases.** An
in-range index or `length` on a dyn string raises "Cannot create property
'0' on string 'abc'" where Node raises "Cannot assign to read only
property '0' of string 'abc'" — a different V8 message for the same
refusal. Out-of-range indices and named keys agree exactly ("Cannot
create property '9' on string 'abc'"), so only the read-only pair
diverges.

**RETIRED (increment 23 P4, board #98) — a write on a boxed FUNCTION no
longer throws.** This entry ORIGINALLY registered `f.x = 1` throwing the
same catchable "Cannot create property 'x' on function" the primitive
receivers get, where Node succeeds and reads it back — a boxed
function's payload carried the closure, its call thunk, its signature,
its name and its arity, and NO property table, so there was nothing a
write could land in. P4 gave it one (see the Amendment above): the write
now succeeds, and every read-shaped surface agrees with Node over it —
`f.x`, `Object.hasOwn(f, "x")`, `Object.keys(f)`, and both inspect
renderers now show an ENUMERABLE property in an appended block (a stale
code comment claiming neither renderer's FUNC arm ever would is
corrected alongside this entry, not a divergence of its own). The two
members Node ALWAYS defines (`name`, `length`) are UNCHANGED and still
answered by keyGet's built-in fallback beneath the table — S020 covers
what those two answer when read (a SEPARATE, unrelated divergence: a
compile-time approximation of the DEFINED name/arity, not about
property storage), unaffected by this retirement.

**`Object.assign` onto a non-object target copies NOTHING, silently.**
`Object.assign(arrTarget, {k: 7})` writes `k` through in Node and lists
it in `Object.keys`; here nothing is copied, no throw and no message. The loudness claim above is about the `d[k] = v` spelling
alone — this arm is the one place a keyed write disappears without a
word.

**Index bands.** The canonical-index parse accepts `[0, 2147483639]` (its
overflow guard's ceiling). Inside that band a large index attempts a
DENSE allocation of everything below it and dies UNCATCHABLY: the wasm
lane traps "requested new array is too large" with no output at all, the
C lane aborts with "scriptc: out of memory" and SIGABRT, and Node
succeeds instantly with a sparse array. The exact index where this begins
is allocator-dependent, not a fixed constant; `a[1000000] = 7` still
allocates and matches Node on `length` and the reads (its million padded
keys are paragraph one's divergence, not this one's). Above the band, `[2147483640, 4294967294]` — real
array indices to Node — take the "Cannot create property" throw instead,
as does anything at or past 2^32-1, which Node treats as an ordinary
named property and writes.

**Rationale:** inherited from the C runtime's dyn tree. Holes, an expando
map and a sparse representation are all the same missing feature: a
second storage plane per array that `Object.keys`, the enumeration walks,
JSON and the inspect surface would each have to merge with the dense
indices, with its own key-order question. That is a feature, not a fix.
The uncatchable band is the S008 shape — an allocation the tier cannot
serve is a trap, not a diagnosable error — and it is reachable only by
programs that would have built a two-billion-element array on purpose.
**Tested by:** the wasm emitter unit tests — one pinning the refusal text
for every receiver kind (each verified against real Node, which agrees on
all of them but the array), one pinning the index writes, their padding,
and the enumeration divergence the padding causes. No corpus program can
pin any of it: a program observing any of these would fail the
differential on every lane by construction, and the program that
exercises the index writes (`2601-dyn-keyed-write-ops.js`) still refuses
on the wasm lane for an unrelated reason — it prints its dyn values, and
the inspect surface has not landed.

**Amendment (unit H): ISLAND arrays no longer pad on the wasm lane.**
Since `any[]` became the island array (S014's unit-H amendment), the
padding would have answered silently for every `any[]` growth write; an
island write past the length (jsOp setIdx) now throws a named Error
instead (S110 (f)). The checked-dynamic (`unknown`) keyed write described
above keeps its padding.

## S017 — `for...of` over a COMPUTED member names the value, not the source *(inherited)*

V8's not-iterable TypeError names the source expression whenever it can
render one, and the lowering threads that spelling through only for a
syntactically BARE identifier or an unparenthesized dotted chain — a
computed access, a parenthesized source, or an `as` cast all fall back
to the kind wording. So `for (const v of arr[0])` over a number raises
"number 5 is not iterable (cannot read property Symbol(Symbol.iterator))"
where Node raises "arr[0] is not iterable"; the same holds for `o['p']`,
`o[k]`, `(n5)`, `(deep.a).b` and `n5 as unknown[]`, while bare `n5`,
`o.p` and `deep.a.b` render correctly. DESTRUCTURING position is
unaffected — V8 itself falls back to the kind wording for any member
access there (`const [z] = arr[0]` says "number 5 is not iterable …" in
Node too), so the lanes agree. Everything else about the message is
byte-exact, the kind wording included: "undefined", "object null",
"boolean true", "number 5", "function", and bare "object" for a plain
`{}`. **Rationale:** inherited — the spelling is a compile-time string
the lowering passes to the runtime's pack helper, and it supplies one
only where a simple source text is at hand; the fallback is the runtime's
own kind renderer (`sc_dyn_iter_n`). Reproduced identically on the C
lane, message for message. Widening it means teaching the lowering to
re-render arbitrary expression source, which is a source-mapping feature
rather than a runtime one. **Tested by:** the wasm emitter unit test,
which pins the diverging shape beside the ones that agree. No corpus
program can pin it — one whose output observed it would fail the
differential on every lane by construction.

**See also S018**, the same lowering habit at the call site: a spelling
where one is cheap to lift from the source, a fixed fallback otherwise.
The two entries differ in which shapes fall back and in what the
fallback says, but they have one cause and one fix — a frontend that
re-renders expression source the way V8 does would close both at once.

## S018 — `<x> is not a function` names the callee's SOURCE TEXT, not V8's re-rendering *(inherited)*

Calling a checked-dynamic value that is not a function throws Node's
catchable TypeError, and the name in it is a compile-time string the
lowering threads through: the identifier's text for a bare identifier,
`getText()` for a property or element access, and the literal word
"value" for every other callee shape. V8 instead re-renders the callee
from its own AST, so the two part company in three places. `(g)(1)` says
"g is not a function" in Node and "value is not a function" here (any
parenthesized callee); `o . a . b (1)` says "o.a.b" there and
"o . a . b" here (raw source keeps the spaces); and a callee with no referenceable spelling at all,
such as `(c ? g : g)(1)`,
says "(intermediate value)(intermediate value)(intermediate value)"
there and "value" here. The shapes that AGREE are the common ones: a
bare identifier, a dotted chain, a computed access with a variable key
(`o[k]`), an element index (`o.arr[0]`), and — since board #243 made a
literal-key callee a method call — a callee ending in a literal key
(`o["f"]()` says "o.f" and `o["list"][0]()` says "o.list[0]", V8's
re-rendering of the whole callee; they said `o["f"]` and `o["list"][0]`
before). A literal-key call with SPREAD arguments (`o["f"](...xs)`) keeps
the stored-member path and its source spelling `o["f"]`. Argument EVALUATION order
is unaffected and exact — arguments run, in source order, before the
callability test, so their side effects appear in Node's order on every
lane. An `as`-CAST callee never reaches this message at all: `(g as F)(1)`
validates `g` against `F` first and raises S009's "expected function at
$, got number" instead, which is a different divergence with a different
rationale.

**Rationale:** inherited, and S017's divergence one node over: the same
lowering habit (a compile-time spelling where it is cheap, a fixed
fallback otherwise), the same runtime consuming it (`scr_dyn_call`'s
`what`), reproduced identically on the C lane message for message.
Closing it means teaching the lowering to re-render arbitrary expression
source the way V8 does, which is a source-mapping feature rather than a
runtime one — and because S017 has the same cause, one frontend
re-renderer closes both entries. That is task-tracked as a single joint
item rather than two. **Tested by:** the wasm emitter unit test, which
pins the diverging spellings beside the agreeing ones. No corpus program
can pin it — one whose output observed the divergence would fail the
differential on every lane by construction;
`1667-dyn-fn-not-callable.cjs` covers the agreeing spellings
differentially.

## S019 — `String(f)` on a boxed function renders the native-code form, not the source *(inherited)*

`Function.prototype.toString` echoes a function's SOURCE TEXT in Node.
A compiled program does not carry its source, so a function that crossed
the `unknown` boundary renders the form engines use for their own
non-JS functions: `"function " + f.name + "() { [native code] }"`, with
the name simply absent (and its space kept) when the value is anonymous.
So `String(named)` answers "function named() { [native code] }" here and
"function named(a, b) { return a + b; }" in Node. Node itself prints the
native-code form for its builtins — `String(Math.max)` is "function
max() { [native code] }" on both lanes — so the shape is JS's own, not
an invention; only the source-carrying case diverges. The neighbouring
answers are exact: `typeof f` is "function", `Object.keys(f)` is `[]`,
and `f === g` compares the boxed CLOSURE, so one function crossing the
boundary twice stays one JS value. The NAME this text embeds is the
approximation S020 registers, so a value whose `f.name` is wrong there
renders the same wrong name here.

**`util.format`'s `%s` reaches for this same text in Node and gets a
different answer here.** Node's `%s` arm is `String(arg)` for anything that
is not an object, so `format('%s', f)` prints the SOURCE, while this tier
prints inspect's `[Function: name]` / `[Function (anonymous)]` form (on
every lane — the C runtime's `scr_insp_dyn_s` does the same). Since the
source text is out of reach either way, the choice is between two non-Node
answers, and the two `%s` sites share one lowering with `console.log`'s
rest arguments — where the inspect form IS Node's answer. Splitting them
means a second libCall carrying the `%s` rule, which is not yet worth it.
Only the DYN path is affected: `%s` over a statically-typed function value
refuses by name rather than answering.

**Rationale:** inherited from the C runtime, which renders exactly this
text for the same reason. Reproducing Node would mean shipping every
boxable function's source text in the binary and a decision about which
source — pre- or post-lowering — the program should claim to be, which
is a feature (and a size cost) rather than a fix. **Tested by:** the wasm
emitter unit test, which pins the named and anonymous forms. No corpus
program can pin it — one whose output observed it would fail the
differential on every lane by construction.

## S020 — `f.name` and `f.length` on a boxed function are compile-time approximations *(inherited)*

The two members a function value carries across the `unknown` boundary
are captured when the box is BUILT, from what the lowering can see at
that site — not from the function's own definition. Both are close
enough to be mistaken for exact, and neither is.

**`f.name` is the spelling of the BINDING the value was boxed from.**
That coincides with Node whenever the function was *defined* at that
binding, which is the common case and why the divergence hides:
`function realName() {}` boxed as `realName`, `const anon = function
() {}` and `const arrow = () => {}` all answer exactly what Node's
inferred-name rules answer. It parts company as soon as the value and
the binding come apart. Through an ALIAS, `const alias = realName`
boxed at `alias` answers "alias" where Node answers "realName" — Node's
name is fixed at definition and never re-inferred by assignment. Out of
a FACTORY, `const got = factory()` answers "got" where Node answers the
inner function's own name. And a value boxed inside a CONVERTING
COMPOSITE — a union arm, a thunk's result, an adapter's argument — has
no binding to read at all, so it is ANONYMOUS and answers the empty
string where Node answers the real name: a function returned through a
boxed call, or handed back out of one, loses its name entirely.

**`f.length` is the DECLARED parameter count**, where JS stops counting
at the first parameter with a DEFAULT. The two markers that look alike
here behave oppositely, and the split is the whole rule: TypeScript's
`b?: number` is a TYPE-level marker that ERASES, so Node sees an
ordinary parameter and counts it, and both lanes agree; `b = 1` is a
real initializer that survives into the JS Node runs, so Node stops
there and this lane does not. Four shapes, this lane first: `function
opt(a, b?)` answers 2 and 2 — agreeing; `function def(a, b = 1)`
answers 2 where Node answers 1; `function def2(a = 0, b = 1)` answers 2
where Node answers 0; and `function mix(a, b?, c = 3)` answers 3 where
Node answers 2, the mixed case that shows the `?` being counted and the
`= 3` not.

ONLY THE REPORTED NUMBER DIVERGES — calls through the box behave exactly
like Node, defaults included. `def(a, b = 1)` invoked through its box as
`d(5)` answers 6 on every lane, because the lowering types a defaulted
parameter as `T | undefined`, so the thunk's per-argument check admits
the missing argument and the body applies its own default. Anyone
debugging a wrong `f.length` should stop at this entry; a call that
throws `expected number at $[1]` for a defaulted parameter is a REAL
thunk bug and not this divergence.

**Rationale:** inherited — every lane builds the box from the same IR,
whose `dynFrom` node carries a best-effort `fnName` from the binding and
whose func type carries every declared parameter. Reproduced identically
on the C lane, value for value. This is the same FAMILY of cause as
S017 and S018 — a compile-time approximation standing in for something
the engine derives at runtime — but NOT the same fix: those two want a
source re-renderer, while this one wants the frontend to thread the
function's DEFINED name (and its pre-initializer parameter count)
through `dynFrom` instead of the box site's spelling. Task-tracked with
them as one frontend item. **Tested by:** the wasm emitter unit test,
which pins every case above with Node's answer beside it in a comment —
the S014 argument, since no corpus program can pin any of it: one whose
output observed the divergence would fail the differential on every lane
by construction.

## S021 — A caught Error crossing into `unknown` becomes an object whose members ENUMERATE *(inherited)*

The checked-dynamic tree has no notion of a non-enumerable property, so
the error encoding both of its producers build — `caughtToDyn` and the
error-rooted `dynFrom` — stores its parts as ordinary own members: the
reserved marker `%error`, then `name`, `message`, and `code` where one
is stamped. Node's `Error` carries `name` and `message` as
non-enumerable own (or prototype) properties and has no marker at all,
so every enumeration surface parts company. On a `TypeError("boom")`
that crossed the boundary, `Object.keys` answers
`["%error","name","message"]` here and `[]` in Node,
`JSON.stringify` answers `{"%error":true,"name":"TypeError",
"message":"boom"}` where Node answers `{}`, and `"%error" in err` and
`Object.hasOwn(err, "name")` are true here and false (respectively
false and false) there. `for...in` and `Object.values`/`entries` follow
`keys`.

WHAT AGREES, because the encoding was designed around these: `String(err)`
is Error.prototype.toString over the same two members and byte-exact
including its empty-side rules ("Weird" for a message-less error, the
message alone for a name-less one); `err instanceof Error` is the marker
test and answers true; `typeof` is "object" and the value is truthy; a
user `extends Error` class keeps its own `name` through the crossing; and
IDENTITY holds — one error crossing twice compares `===` equal, because
both producers go through the same per-error cache the C runtime spells
`scr_errdyn_cache`.

`err.name` and `err.message` read what Node reads AT THE FIRST CROSSING,
and only then. The encoding COPIES both strings into the object it
builds, and the identity cache above then pins that object, so a
`err.message = "MUTATED"` performed on the typed error after it crossed
is invisible on every dyn read — including a second crossing, which
answers the cached box rather than rebuilding it. `try { throw new
TypeError("boom") } catch (e)`, cross, mutate, cross again: both dyn
views read "TypeError"/"boom" here and "Renamed"/"MUTATED" in Node,
while `===` between them holds on both. Write-through is not a fix
within this design — the box would have to ALIAS the error rather than
copy it, which is S014's shape and S014's answer.

**Rationale:** inherited from the C runtime's dyn tree, and the same
shape of missing feature as S016's holes: a non-enumerable bit is a
second storage plane that `Object.keys`, the enumeration walks, JSON and
the inspect surface would each have to consult, with its own ordering
question. The marker specifically cannot hide behind that bit either —
it is what `instanceof Error` reads. Upstream cites this encoding as
"SEMANTICS.md 67" in half a dozen places (`caughtToDynHelper`, the
`caughtToDyn` and `dynTest` node docs, three lowering sites); that number
belongs to the register they never shipped and resolves to NOTHING on
this file, so S021 and S022 are its replacement, verified empirically
against both lanes rather than transcribed. The marker's other cost —
a user object that spells `%error` itself — is S025. **Tested by:** the wasm emitter
unit test, with Node's answers beside ours; the C lane reproduces every
line of it, verified by running both. No corpus program can pin it — one
whose output observed the divergence would fail the differential on
every lane by construction.

**Amendment (increment 23 P2b): the `assert` failure renderer is a
surface where this parts company visibly.** `assert.eqDyn`'s renderer
(`cfInspect`/`cfValue`) has NO special case for the `%error` marker —
an Error VALUE reached as an assert operand renders as this entry's own
raw encoding, a plain object dump over its OWN own-enumerable members,
not Node's real Error rendering (which shows `name: message` followed
by the FULL STACK TRACE, since `util.inspect` special-cases
`instanceof Error`). Own re-measurement, `assert.deepStrictEqual({e:
err, y: 1}, {e: err, y: 2})` where `err` is a caught `TypeError("boom")`
crossed to `unknown`: Node's real message renders `e: TypeError:
boom\n    at ...(the full stack)...` (itself long enough to trigger the
`... Skipped lines` >50-line collapse in Node's own case); this tier's
compiled build renders `e: {\n  '%error': true,\n  message: 'boom',\n
name: 'TypeError'\n}` — the marker ITSELF is visible as a rendered key,
which Node's own output never shows under ANY circumstance (S021's own
main text already establishes this key is invisible to every OTHER
enumeration surface — `Object.keys`, `JSON.stringify`, `for...in`; the
assert renderer is simply another consumer of the SAME dyn
representation, inheriting the SAME visibility). No corpus program
constructs an Error-valued assert operand (D.7's own `expectsErrDyn`
compares the THROWN error's OWN key walk directly, never renders it via
`cfInspect`), so this is unclaimed by the six; registered here as the
assert-specific instance of S021's own general rule rather than as a
separate S-number, per H-3's own recommended split (design-p2.txt).
**Tested by:** own re-measurement above (not a standing pin — the
six do not reach it, and a dedicated pin would duplicate S021's own
already-covered "the marker enumerates" finding at one more call
site rather than establish anything new).

**Amendment (Unit B review): `JSON.stringify` on the wasm tier skips the
marker, `name`, `message` and `stack` of an error-encoded object**, so a
crossed `Error("x")` serializes as `{}` and one carrying a stamped or
assigned `code` as `{"code":...}` — Node's answers (V8's `name`, `message`
and `stack` are non-enumerable, and an assigned `stack` stays so; a Node
error's `code` is enumerable). What remains of this entry for JSON: ANY
assignment to `name` (`e.name = "Renamed"` on a caught error, or a
subclass's `this.name = ...`) serializes WITHOUT it, where Node prints
`{"name":"Renamed"}` (the assignment makes an own enumerable property —
the encoding cannot tell an assigned name from the class default), and a
DOMException's derived `code` and `cause` serialize (Node's are not own
enumerable). A user object carrying the marker loses those keys too —
S025. Every other surface above is unchanged, and the llvm and c lanes
still serialize the members.
**Tested by:** the DCALS-07 row in `tests/harness/wasm-differential.test.ts`
(the hidden `stack` included) and `wasm-emitter.test.ts`'s "S021
amendment" row; the assigned-`name` residue is measured, not pinned.

## S022 — A non-Error exception payload crossing into `unknown` becomes an EMPTY object *(inherited)*

The exception cell type-erases everything that is not a scalar, an error
or a dyn value: a record, an array, a closure, a union, a class instance
rooted outside the error hierarchy all arrive as one untyped reference
with no runtime shape to walk. `caughtToDyn` therefore answers a fresh
EMPTY dyn object for them — truthy, `typeof "object"`, `String()`
"[object Object]", `Object.keys` empty, every field unreadable. So
`try { throw { a: 1 } } catch (e) { const u: unknown = e; }` reads
`u.a` as `undefined` here and `1` in Node, and a thrown array answers
`Array.isArray` false here and true there.

The neighbours are exact. Scalars convert to their own dyn kinds
(`throw 42`, `throw "s"`, `throw false`), errors take S021's encoding,
and a thrown DYN value passes back BY REFERENCE — `throw u` then
catching into `unknown` yields the very same value, `===` to the
original, with its members and `Array.isArray` intact, which is what
keeps the traced-throw idiom honest.

**Rationale:** inherited from the C runtime, whose `sc_cd` walker has
the same three arms and the same fallthrough — and which cites the
dangling "SEMANTICS.md 67" for this arm too (see S021's rationale). Converting the rest means
the cell carrying a per-payload to-dyn walker beside the reference — a
type tag the throw site would have to stamp and the catch site dispatch
on, which is a representation change rather than a fix, and one no
corpus program has ever wanted. **Tested by:** the wasm emitter unit
test; `1554-caught-into-unknown.ts` exercises the agreeing arms
differentially on the native lanes (its mode 7 `throw { a: 1 }` prints
only "truthy other", which both worlds agree on). No corpus program can
pin the divergence itself.

**Amendment (direct `String(e)`, increment 21 rider):** the same
erasure surfaces one step earlier than the crossing this entry names —
`String(e)` / `` `${e}` `` DIRECTLY on the catch binding, without any
`unknown` in between. The exception snapshot's own toString
(`scr_caught_to_string`, now ported to the wasm tier's "caught"
toString arm) renders every type-erased payload as `"[object Object]"`:
a thrown array (Node: `"1,2,3"` via Array.prototype.toString), a thrown
function (Node: its source text), a thrown object carrying a custom
`toString` (Node: its result), and any class instance outside the
%Error hierarchy. Scalars and %Error-rooted payloads are exact (the
Error arm renders through the same helper as `e.toString()` on a
statically-typed Error, brackets included). Same representation limit,
same rationale, shared by all three lanes. **Tested by:** the wasm
emitter unit test's `toString:caught` pins (the arr/fn rows pin the
divergent texts beside a comment giving Node's answers);
`1431-caught-tostring.ts` pins the AGREEING arms differentially —
its thrown plain object and non-Error class instance print
`"[object Object]"` in Node too, so no corpus program pins the
divergence itself.

## S023 — The dyn INVOKE surface fences unmodeled (kind, method) pairs at RUNTIME *(inherited)*

`recv.m(...)` on a checked-dynamic receiver dispatches on the receiver's
runtime KIND, so which pairs are implemented cannot be decided at compile
time — the tier's usual named refusal has nothing to name. A pair the
prototype really declares but this tier does not implement therefore
throws a LOUD, catchable, plain `Error` (never a `TypeError`, so a
handler testing for one is not misled), and never a wrong answer. Node
answers all of these:

- `'String.prototype.at'` and `'String.prototype.concat'` on a dyn
  string — `"'String.prototype.at' on a dynamic value is not supported
  yet"`.
- `indexOf`, `lastIndexOf` and `includes` on a dyn STRING whose needle is
  not itself a string: Node applies ToString, this tier has no coercion.
  With a string needle all three are exact, `fromIndex` included.
- Any INDEX argument that is not a number, on any receiver — `a.slice("x")`,
  `a.at(true)`, `a.indexOf(1, "2")` — raises the `TypeError`
  `"<callee>: non-number index arguments on a dynamic receiver are not
  supported yet"`. A missing index takes its default and a number
  truncates toward zero, both JS-exact — including the three rules that
  differ by method, which are implemented rather than approximated. A
  NUMBER index is relative on `Array.prototype` (negatives count from
  the end) and clamped on `String.prototype` (they do not). NaN reads as
  0 everywhere except `String.prototype.lastIndexOf`, where ToNumber
  sends it to +∞ and the whole string is searched. And an explicit
  `undefined` index coincides with an absent one everywhere except
  `Array.prototype.lastIndexOf`, whose spec branches on argument
  PRESENCE rather than value: `[1,2,3,1,2,3].lastIndexOf(2, undefined)`
  coerces to 0 and answers -1, where the absent form starts at the last
  index and answers 4.
- `f.apply(thisArg, argsArray)` where `argsArray` is an OBJECT rather
  than an array — an array-LIKE, which Node walks through
  CreateListFromArrayLike's `length` and index reads and calls
  successfully. This tier reads neither, so it raises
  `"'Function.prototype.apply' with an array-like argsArray on a dynamic
  value is not supported yet"` rather than borrowing a message for a case
  Node answers. A PRIMITIVE `argsArray` is NOT fenced: `f.apply(null,
  "ab")` raises `TypeError: CreateListFromArrayLike called on
  non-object`, which is Node's own answer there, verified.

Everything else about the surface is Node's own answer, including the
refusals: a name the receiver's prototype lacks throws Node's
"<callee> is not a function" (S018 governs the spelling), a nullish
receiver throws "Cannot read properties of undefined (reading 'm')" —
and throws it at the MEMBER GET, before an argument is evaluated, so
`nul.push(sideEffect())` runs nothing before it. The implemented Array,
String-slice and Function apply/call semantics are Node's own up to the
divergences registered elsewhere: `map`'s padded output slots (S016),
`sort`'s comparison sequence, its mutating-comparator case and its
comparator-result coercion (S024).

**Rationale:** mostly inherited — the C runtime fences the first three
with exactly these texts, and the fences are TODO markers rather than
stances: each is one coercion (ToString, ToNumber) away from being
implementable, and coercion over an arbitrary dyn value is its own
increment. The alternative — refusing every dyn `.at()` at compile time
because the receiver MIGHT be a string — would take the implemented
array path down with it. The `apply` fence is this lane's own: the C
runtime throws CreateListFromArrayLike's TypeError for an array-like
object as well, which reads as Node's answer and is not one, so the
loud fence replaces it here rather than inheriting a message that
misdescribes a case Node serves. **Tested by:** the wasm emitter unit
test pins each text; the C lane throws the first three verbatim,
verified by running both. No corpus program can pin them: a program
reaching one would fail the differential against Node on every lane.

**Five places this lane is Node-exact where the C runtime is not**, noted
here because a reader comparing the lanes will meet them. The
callable-callback gate renders its operand with V8's TYPED wording
(`arr.map(5)` says "number 5 is not a function", and a string operand
`string "abc" is not a function`) where the C runtime renders the
value's ToString image. `sort`'s DEFAULT comparator orders the
ToString images by UTF-16 code UNIT, ECMAScript's own order, where the C
runtime's UTF-8 storage makes the same comparison code-POINT order —
S005's divergence, which the flagged comparator exists to avoid.
`sort`'s comparator GATE renders the value it rejected the way V8 builds
a message — without running user code, so `#<Object>` and
`[object Array]` — where the C runtime renders ToString ("[object
Object]", "9,8"). The fromIndex argument of `indexOf`, `lastIndexOf` and
`includes` is threaded on both receivers, with each method's own rule;
the C runtime ignores the argument entirely (`[1,2,3,1].indexOf(1, 1)`
answers 3 here and Node, 0 there). And a NULLISH receiver throws at the
member get, before the arguments run, where the C runtime evaluates them
first. All five are gaps in the C lane rather than stances, and are
tracked as such.

## S024 — `sort`'s ORDER is Node-exact; its comparison SEQUENCE is not *(inherited)*

`Array.prototype.sort` over a dyn receiver is a stable merge sort, where
V8 runs TimSort. For every consistent comparator that ANSWERS IN NUMBERS
OR BOOLEANS the two agree on the answer — same order, same stability,
same identity (`a.sort() === a`), verified across 74 outputs spanning
lengths 0 to 33 plus duplicate-heavy, reverse-sorted and pre-sorted
shapes with both the default and a numeric
comparator. What differs is HOW MANY TIMES the comparator runs and in
what pairing, which a comparator with side effects can see:
`[3,1,2].sort(counting)` calls it 4 times in Node, 3 on the C lane and 3
here; `[5,4,3,2,1]` is 4 / 7 / 5; `[5,2,8,1,9,3,7,4,6,0,11,10]` is
29 / 29 / 31. The wasm lane's count differs from the C lane's as well,
because its merge runs bottom-up where C's recurses — neither is
"the" answer, and there is no answer to match short of reimplementing
TimSort.

The qualifier in that first sentence is the second divergence.
A comparator's RESULT is read from the shared numeric slot, which
numbers and booleans fill and no other kind does — C's rule, inherited —
so a comparator answering anything else reads as 0 at every pair and
sorts NOTHING. The reachable case is a string-returning comparator,
which is perfectly consistent and which Node handles by applying
ToNumber to the result: `[3,1,2].sort((x, y) => x < y ? "-1" : "1")`
answers `1,2,3` in Node and `3,1,2` here, silently. (Full ToNumber over
an arbitrary dyn value is the same rock S023's index-argument fence
names — one coercion away, and its own increment.) An INCONSISTENT
comparator is outside the claim entirely, as ECMA-262 leaves it
implementation-defined: a boolean `(x, y) => x > y` never answers
negative, and `[3,1,2]` sorted with it is `1,2,3` here and `3,1,2` in
Node.

A comparator that MUTATES the receiver is the same fact at its loudest.
Both tiers sort a SNAPSHOT (the spec's shape, and what keeps a mutating
comparator from reordering the elements being compared), then write the
result back index by index for as many indices as the receiver still
has — so a comparator that shrinks the array keeps the shrink, where V8
writes its whole snapshot back and RESTORES the removed elements:
`[5,3,9,1,7,2]` with a comparator that pops twice answers
`1,2,3,5,7,9` (length 6) in Node and `1,2,3,5` (length 4) on both tiers.

**Rationale:** ECMA-262 leaves both the algorithm and the mutating-
comparator case implementation-defined, so neither is a conformance
question; matching V8's observable comparison sequence would mean
shipping TimSort, which is a performance-and-fidelity feature nobody has
asked for and a much larger surface to get wrong than a merge whose
ORDER is provably right. The result coercion is the one arm here that IS
a conformance gap rather than a licensed choice — the spec's step is
plainly ToNumber — and it is inherited exactly: the C runtime reads the
same two kinds from the same union slot, so narrowing the claim keeps
the lanes describable together while the coercion increment is
outstanding. **Tested by:** the wasm emitter unit test pins the
ordering, the stability, the receiver identity — the properties that ARE
specified — and the string-comparator result, with Node's answer beside
ours. No corpus program can pin the sequence: one that counted
comparisons would fail the differential against Node on every lane.

## S025 — A dyn object carrying the reserved `%error` key IS an error *(inherited)*

S021's encoding marks an error with an ordinary own member named
`%error`, and nothing reserves that name on the way IN. A dyn object
that happens to carry it is therefore classified as an error by every
surface that reads the marker — and `JSON.parse` over untrusted input
reaches it directly. On
`JSON.parse('{"%error":true,"name":"Fake","message":"m"}')`,
`u instanceof Error` answers true where Node answers false, and
`String(u)` renders Error.prototype.toString's `"Fake: m"` where Node
renders `"[object Object]"`. Only the marker's PRESENCE is consulted,
never its value, so `{"%error":1}` and `{"%error":false}` are errors
here too; with no `name` or `message` beside it, `String(u)` is the
EMPTY string (Error.prototype.toString over two absent members) against
Node's `"[object Object]"`. `typeof` and `Object.keys` agree with Node
throughout — the key really is an own member on both sides, which is
S021's other half seen from this direction.

**Amendment (Unit B review): `JSON.stringify` is a marker-confusable
surface on the wasm tier.** In a module that can build the error
encoding (S021's JSON amendment), stringify skips `%error`, `name`,
`message` and `stack` of ANY object carrying the marker: the parsed
`{"%error":true,"name":"n","message":"m","z":2}` prints `{"z":2}` where
Node prints all four keys, and a caught error given `e["%error"] = "user"`
prints `{}` where Node prints `{"%error":"user"}`. In a module that cannot
build the encoding, stringify prints every key, as before. **Tested by:**
measured (the review probes), not pinned.

**Rationale:** inherited — the C runtime uses the same marker and
reproduces every line above, verified by running it. The marker cannot
hide behind a non-enumerable bit for the reason S021's rationale gives
(it is what `instanceof Error` reads), so a reserved key with no
reservation is what the encoding costs. Fixing it means either that
second storage plane or a marker user data cannot spell — a sentinel
OBJECT identity in place of a string key, which the entry table's
`memcmp` walk has no way to compare today. Both are representation
changes rather than repairs. The `%` prefix is at least not a name
idiomatic JS data uses, which is presumably why upstream picked it; this
entry records that "not idiomatic" is not "not reachable". **Tested by:**
the wasm emitter unit test, with Node's answers beside ours; the C lane
reproduces it. No corpus program can pin it — one whose output observed
the divergence would fail the differential on every lane by
construction.

## S026 — `JSON.stringify` caps nesting depth at 1000 *(wasm tier)*

`JSON.stringify` on this tier throws a catchable `RangeError` reading
`Maximum call stack size exceeded` rather than recurse past 1000 levels of
array/object nesting. BOTH walkers are capped and both share the counter:
the dyn-root walker, which has no static type to direct it, and the
type-directed walker for a RECURSIVE record shape, which is recursive at
runtime for the same reason its type is recursive at compile time. A type
that cannot recurse never reaches the check — its nesting is bounded by
its own structure — so acyclic shapes pay nothing.

**Node caps this too, and reports the same error with the same message.**
That is the difference from S013, which this entry otherwise mirrors: V8's
JSON *parser* is iterative and has no limit at all, but its *stringifier*
recurses, so deep nesting throws there as well. What diverges is only the
LIMIT — ours is a fixed 1000 whatever the stack holds, V8's is
implementation-defined and moves with the stack. Measured on Node 24.18,
plain nested objects: the deepest that stringifies is roughly 875 levels
under `--stack-size=200`, ~4.5k under the default stack, and ~18k under
`--stack-size=4000`. Those numbers drift by a few levels run to run with
whatever else is on the stack when the call happens, which is the point —
there is no fixed depth to state. So a tree nested 2000 deep stringifies
under Node's default stack and throws here, and one nested 800 deep
stringifies here and throws under a small-stack Node. Neither side is
uniformly stricter.

CYCLES ARE NOT WHAT THIS ENTRY COVERS, and no longer differ between the
two walkers. Both detect them exactly: a cyclic value — of a recursive
record type, or a dyn tree built through dyn keyed writes (`const o: any =
{}; o.self = o`) — throws V8's `TypeError: Converting circular structure
to JSON` with the message built byte for byte, edge path and elision
included, through one shared builder. So the cap reports deep ACYCLIC
nesting only. (Until increment 16 the dyn walker had no cycle detector and
answered a cyclic tree with the RangeError above — right that it failed,
wrong about why. This entry named a seen stack as the fix; the dyn walker
grew one, sharing `jbEnter` with the static path, and the gap is closed.)

WHAT THE OTHER LANES DO with the same inputs, all measured rather than
assumed. On a CYCLIC dyn tree the C runtime has no guard of either kind:
recursive descent exhausts the C stack and the process dies of SIGSEGV
after ~3.5s (`scriptc: program killed by SIGSEGV`). On a deep ACYCLIC
value of a recursive static type C is far more forgiving than either
capped walker — 120000 levels serialize fine — but it has no guard there
either, and somewhere between 120000 and 300000 it SIGSEGVs the same way.
An uncatchable crash at an unpredictable depth is strictly worse than a
documented catchable failure at a fixed one, which is the whole argument
for the cap.

**Rationale:** the same as S013's, and the wasm stack makes it sharper
than the native lanes need. Both walkers are recursive descent over a
tree of unbounded depth, and V8's WASM stack is far smaller than the
native one C gets: UNCAPPED, the static walker was measured trapping
between 5000 and 10000 levels — and trapping UNCATCHABLY, with the
program's own `try` never running and its buffered output never flushed,
which is the S003/S007 abort family rather than an exception. Node throws
a catchable RangeError on the same input. Capping turns an uncatchable
abort at an unpredictable depth into the catchable failure Node already
gives, at a documented one. The message is not invented — it is exactly
what Node produces for this class of input. Removing the divergence means
an explicit value stack in both walkers.
**Tested by:** the wasm emitter unit tests, on both paths — 1000 nested
objects serialize and 1001 throws through the dyn walker; a 1000-deep
acyclic value of a recursive record type serializes and 1001 throws
through the static one; a cyclic dyn tree throws the circular TypeError
with its edge path, in the property and index forms both; and the buffer,
seen stack and depth counter all recover for the next call. No corpus
program can pin it: the native lanes diverge from this by construction (C
caps neither path).

## S027 — `util.inspect` of an Error renders the STACKLESS bracket form *(wasm tier)*

`util.inspect(err)` and `console.log(err)` on this tier render
`[Name: message]` — or `[Name]` when the message is empty — where Node
prints the error's `stack`, which begins `Name: message` and continues with
`    at ...` frames. A stamped `code` slot renders as the one extra own
property Node would show alongside: `[Error: boom] { code: 'ENOENT' }`.

This divergence is INHERITED AND WAS NEVER REGISTERED: `scr_inspect.c:655`
calls the stack-carrying Node output "a documented divergence", but the
register it refers to is upstream's, which was never shipped. So this entry
is the first one, and it covers the native lanes' behavior as much as this
tier's — they make the same choice for the same reason.

**This is not an invented form.** It is exactly what Node prints for an
error whose stack is empty, which is why the bracket shape was chosen
rather than something merely plausible. Measured on Node 24.18, setting
`e.stack = ''` first: `new Error('boom')` renders `[Error: boom]`, an
Error with no message renders `[Error]`, `new TypeError('bad')` renders
`[TypeError: bad]`, one with a `code` property renders `[Error: boom] {
code: 'ENOENT' }`, and a multi-line message keeps its newlines with the
continuation lines indented to the property's own level (`{\n  e: [Error:
line one\n  line two]\n}`). Every one of those is reproduced here byte for
byte. The NAME comes from the error's `name`, not its constructor — a
renamed error prints `[Custom: m]`, and this tier stores the name in a slot
for the same reason.

The depth gate follows Node's, including its asymmetry: beyond the depth
budget an error WITH extra properties collapses to `[Error]`, while one
WITHOUT them still prints its full base, because for a stackless error the
bracket form *is* the value rather than a property dump. Measured both ways
(`{ a: { b: { c: e } } }` gives `[Error]` with a `code` present and
`[Error: boom]` without).

**Only the BUILTIN error classes reach this rendering**, and that is what
keeps the claim above exact. `util.inspect` of an error SUBCLASS is fenced
in the frontend (`inspect of 'AppError' values` — a named refusal, not a
silent approximation), so the reconstruction Node performs for subclasses
never arises here. Node's rule is worth recording for whoever unfences
them, because it is not obvious: `improveStack` compares the error's `name`
against its CONSTRUCTOR, and when a name ending in `Error` disagrees it
rewrites the header. Measured with emptied stacks — `class AppError extends
Error {}` renders `[AppError: m]` (the inherited name `Error` is a
substring of the constructor name, so the constructor wins outright),
`class MyType extends TypeError {}` renders `[MyType [TypeError]: m]` (not
a substring, so both appear), and a plain Error renamed to `Custom` renders
`[Custom: m]` (the name does not end in `Error`, so the rule never fires).
This tier stamps the BUILTIN base's name into a slot, which is right for
every class that reaches the renderer and would be wrong for a subclass —
another reason the fence stays until someone ports that rule.

**Rationale:** a compiled wasm module has no JS stack to print. There are
no `.js` source frames, no function-name metadata at runtime, and no
line/column mapping — the information Node's stack is made of does not
exist in the artifact. The options were to print a stack that is a
fabrication, to print nothing where Node prints something, or to print the
form Node itself uses when the stack is empty. The third is the only one
that is both honest and a shape existing Node-targeting code already
handles. Removing the divergence means shipping DWARF-style debug metadata
and a stack-walking runtime, which is a different project.

Note this is a rendering divergence only: `err.stack` is a separate
question (the property does not carry frames either), and `err.message`,
`err.name`, `err.code` and `instanceof` are all exact. **Amended by
S054:** a thrown `AssertionError`'s `.message` is the ONE exception to
the "exact" claim above — see S054 for the full boundary.

**Tested by:** the wasm inspect unit tests — the five bracket shapes above,
the `code` property through the frame engine, the multi-line message
indent, and the depth gate in both directions, each pinned against the
Node output measured with an emptied stack. No corpus program can pin the
top-level form: every lane prints its own base there (the C runtime makes
the same choice for the same reason), so the corpus programs that inspect
errors compare wasm against Node only where the two agree.

## S028 — Grid-grouping DISPLAY WIDTH uses Node's non-ICU tables, un-normalized *(wasm tier)*

`util.inspect` lays arrays of seven or more short entries out as a grid
(`groupArrayElements`), and the column arithmetic measures each entry by
DISPLAY WIDTH rather than string length. This tier computes that width by
applying Node's own `isFullWidthCodePoint` / `isZeroWidthCodePoint` tables
per code point. Node computes it differently in two respects, one of which
is a divergence:

- **NFC normalization is omitted here.** Node normalizes before measuring
  in BOTH of its implementations — the non-ICU fallback
  (`inspect.js:2695-2711`) normalizes and then walks these very tables, and
  the ICU path normalizes before handing off to `icu.getStringWidth`.
  Normalization can change the code point COUNT and not only widths:
  U+1D160 decomposes into three characters that do not recompose, so Node
  measures it 3 where a per-code-point walk answers 1.
- **The tables are stale against ICU's East_Asian_Width data**, which
  separates this tier from an ICU-enabled Node (the usual build) but not
  from Node's own fallback. Measured over all 1,114,112 code points, the
  two answers differ on 11148, in 480 contiguous ranges, in five buckets
  that sum to exactly that total:

  | this tier | ICU-Node | count | what they are |
  |---|---|---|---|
  | 1 | 2 | 9013 | emoji and symbols ICU widened (U+231A, U+2648..U+2653, ...) |
  | 1 | 0 | 1812 | marks ICU calls zero-width — 1648 of them Mn/Me, the other 164 format and unassigned code points |
  | 2 | 1 | 299 | unassigned code points inside the tables' ranges (U+3040, U+4DC0..U+4DFF, U+1B002) |
  | 0 | 1 | 15 | U+20F1..U+20FF — unassigned tail of the symbol-marks block the tables call zero-width |
  | 1 | 3 | 9 | U+1D160..U+1D164, U+1D1BD..U+1D1C0 — the NFC expansions above |

**VT-sequence stripping is NOT part of this divergence**, though it looks
like it should be, and there are two independent reasons — either alone
settles it. First, the strip is PARAMETERIZED and off here:
`getStringWidth(str, removeControlChars)` takes the flag and
`groupArrayElements` passes `ctx.colors`, false under the default options
this tier accepts, so Node does not strip either. Measured:
`getStringWidth("\x1b[31mred\x1b[0m")` is 3 with stripping and 10 without,
and 10 is what this tier answers. Second, and more durably: **no grid entry
can contain a raw ESC in the first place.** Entries are renderings, and
strEscape turns U+001B into the four characters `\x1B` — so even if the
flag flipped, every entry this tier can produce is already ESC-free and the
two implementations would still agree on all of them.

**The exposure is narrow.** Width feeds grid grouping and nothing else
under the default options (break-length counts UTF-16 code units, which
this tier computes exactly). So a divergence requires an array of seven or
more entries, short enough to group, containing code points in the
disagreeing set. Pure-ASCII data — the overwhelming majority of what gets
inspected — is byte-identical, and any array that breaks to one entry per
line is unaffected whatever it contains.

**Rationale:** matching ICU means shipping an East_Asian_Width table and an
NFC normalizer into every module that inspects anything. The table is tens
of kilobytes and full NFC is a Unicode-data-sized dependency, against a
divergence that needs exotic input in a grid to observe at all. Node's own
non-ICU builds behave the same way modulo normalization, so this is a
stance Node itself ships. Removing the divergence means an NFC
implementation plus current EAW data. (An earlier revision framed this
as shared work with the then-unbuilt `toLowerCase`/`toUpperCase` case
tables; increment 20 shipped those — `casing-tables.ts`/`casing.ts` —
so the NFC/EAW work now stands alone.)

**Tested by:** the wasm inspect unit tests pin `insp_width` by value
against a 99-entry hand-checked table, including the code points where ICU
provably disagrees (U+3040, U+4DC0, U+1B002, U+20FF), so the tests record
which side this tier implements. A GROUPED-GRID case pins the divergence
end to end: ten entries of a digit plus U+0483 (COMBINING CYRILLIC TITLO)
lay out three columns per row here and four in Node, and the test asserts
both the literal output and that it differs from `util.inspect` — so a
future change that silently converges, or diverges further, fails. The
complementary half is pinned too: ASCII grids at the same six shapes are
byte-identical to Node. Corpus programs cover the grid on ASCII data only.

## S029 — `util.inspect` of a dyn tree caps recursion at 1000 *(wasm tier)*

`util.inspect` over a checked-dynamic tree stops descending at 1000 levels
and renders the composite it stopped at as

```
[Object: Inspection interrupted prematurely. Maximum call stack size exceeded.]
```

(`[Array: ...]` for an array, and Node's own doubled-bracket
`[[Object: null prototype]: ...]` for a null-prototype dictionary). The rest
of the render then FINISHES normally: the marker takes the place of one
value, every enclosing level closes, and the call returns a complete string
rather than throwing.

**That text and that degradation are Node's**, not this tier's invention.
`formatRaw` wraps its entry-building loop in a try, and on a stack overflow
`handleMaxCallStackSize` pops the seen stack, restores the indentation level
and returns exactly the string above — so a deep-enough tree gets a
truncated-but-complete rendering out of Node too, with one marker in it.
What diverges is WHEN: ours is a fixed 1000, Node's is wherever its stack
runs out. Measured on Node 24.18, `inspect(chain, { depth: null })` over a
loop-built chain of plain objects: the marker appeared after 929 levels on a
5000-deep tree, and repeated runs across 5000-, 10000-, 12000- and
20000-deep inputs put the cut anywhere from 929 to 2450 levels (929, 967,
969, 1191, 1221, 1244, 1419, 2172, 2450 among the observations), because it
is the stack rather than the tree that decides. There is no fixed depth to
state, and the spread between runs — roughly 1500 levels — is wider than
any single number suggests. 1000 sits inside that band, at its low end: it
reproduces the 929 case closely, and against a run that got 2450 levels deep
our truncated prefix is around 1450 levels shorter. What matches exactly in
every case is the MARKER TEXT and the shape of the degradation — one marker,
then an output that completes.

**The exposure is very narrow.** `depth` defaults to 2, so the walk stops
three levels down for every ordinary call; reaching 1000 takes an explicit
`{ depth: null }` (or a numeric depth past 1000) over a tree that is
actually that deep, which in turn takes a loop that builds one. A cycle does
NOT reach the cap: the seen check precedes the depth check, so a cyclic tree
answers `[Circular *N]` at the repeat, however deep the cycle sits.

**Rationale:** S026's, sharpened. The walker is recursive descent over a
tree of unbounded depth, and the wasm stack is far smaller than the native
one — UNCAPPED, the sibling stringify walker was measured trapping between
5000 and 10000 levels, and trapping UNCATCHABLY, with the program's own
`try` never running and its buffered output never flushed (the S003/S007
abort family). Node degrades gracefully on the same input. A fixed cap
reproduces the graceful degradation, including the exact marker, at a
documented depth instead of an unpredictable one. Removing the divergence
means an explicit value stack in the walker — the same work S026 names, and
best done for both walkers at once.

**Tested by:** the wasm inspect unit tests. A 1001-link chain at
`{ depth: null }` renders one marker, with Node's exact text, and completes
(the brace counts balance and the chain's `end: true` leaf is gone); a
1000-link chain renders in full with no marker, which pins the boundary from
both sides; and the engine renders correctly straight afterwards. The marker
TEXT is also asserted against Node in the same test, by inspecting a
20000-deep tree in the test process and matching the string. No corpus
program can pin it: the native lanes cap nothing, and a program whose output
observed this would fail the differential on every lane.

## S030 — `util.inspect` of a dyn PROMISE fences at runtime *(wasm tier)*

A promise that has crossed into `any` — `const p: any = somePromise` boxes
the promise itself, by reference — has no rendering on this tier. Reaching
one, at any depth of an inspected dyn tree, throws a LOUD, catchable, plain
`Error` (never a `TypeError`, so a handler testing for one is not misled):

```
util.inspect of a promise value is not supported yet
```

Node renders `Promise { <pending> }`, `Promise { 42 }` or
`Promise { <rejected> Error: ... }`. This tier models promise STATE (the
async machinery needs it), so the shape is reachable in principle; what is
missing is the settled VALUE's rendering, which re-enters the walker through
a payload the frontend has no static type for. Guessing — printing
`Promise { <pending> }` for a settled promise, say — would be a silently
wrong answer for the one case anyone would notice.

The throw leaves NO state behind: the fence resets the render's buffer,
frame stack, item stack, indentation and circular state before filling the
exception cell, and every recursive step of the walker checks the cell and
unwinds without touching them. So a program that CATCHES the fence and
inspects something else gets a correct rendering.

`insp.dyn` and `insp.dynS` are may-throw seeded for this fence, which the
native lanes need too: `scr_insp_dyn` throws the same text (and two more,
for a runtime handle and an island value — neither constructible on this
tier, both `unreachable` here), and before the seed landed nothing checked
the cell after one, so the exception could outlive the call and surface at
whatever checked next.

**Rationale:** the handle stance, applied to a kind this tier does model
enough of to tempt a guess. A loud catchable failure naming the unsupported
thing is the tier's standing answer for a construct it cannot render
faithfully (S004's shape, S023's mechanism), and inspect is a rendering
surface rather than an invoke surface, which is why this is its own entry
rather than a line in S023. Removing the divergence means rendering the
settled value, which needs a typed path out of the promise payload —
tractable, and a different increment.

**Tested by:** the wasm inspect unit test — the fence's name and text from a
bare promise and from one nested inside a tree (so the unwind crosses frames
the render left open), followed by two further renders that must come out
byte-identical to Node, which is what pins the reset.

## S031 — Hybrid record own-key order is declared-then-overflow, not Node's single interleave *(inherited)*

A record with an index signature (`{ known: number; [k: string]: number }`)
keeps its declared fields as struct slots and its undeclared keys in an
embedded overflow map (`IrRecordShape.indexValue`). Every own-key surface —
`Object.keys`/`values`/`entries`, `for...in`, `JSON.stringify`,
`util.inspect` — enumerates the DECLARED fields first (in `declaredOrder`),
then the overflow's own keys (integer-like keys ascending, then insertion
order — `%w.map.keysJsOrder`, `scr_map_keys_js_order`). Node has no such
split: every property lives in ONE ordered table, and JS own-key order puts
integer-like keys ascending FIRST across every property regardless of
where — declared or dynamically added — it came from, then the rest in
insertion order.

The two orders can disagree whenever an integer-like key is added
DYNAMICALLY on a shape that also has declared (non-integer-like) fields —
the declared field sorts before the integer-like overflow key here, but
Node sorts the integer-like key first regardless of which "store" (JS has
none) it lives in. Measured on Node 24.18 against the C lane:
`interface Basic { known: number; [k: string]: number }`,
`const r: Basic = { known: 1 }; r.b = 2; r["3"] = 3; r.a = 4; r["1"] = 5;`
— `Object.keys(r)` is `['1', '3', 'known', 'b', 'a']` on Node and
`['known', '1', '3', 'b', 'a']` here (C and wasm agree byte-for-byte, as
does `for...in`). `JSON.stringify(r)` shows the identical split:
`{"1":5,"3":3,"known":1,"b":2,"a":4}` on Node,
`{"known":1,"1":5,"3":3,"b":2,"a":4}` here.

**Rationale:** inherited from the C/LLVM lanes, present since index-
signature records first shipped there — this is the wasm tier's FIRST
registration of a cross-lane divergence that predates it, the S027
pattern ("an existing native-lane behavior gets its first SEMANTICS.md
entry when a new lane adopts it"). A C-side comment cites an upstream
scriptc register entry ("SEMANTICS.md 36") for this exact gap, but that
register was never shipped and this file has no corresponding numbered
entry until now. Unifying declared and overflow keys into one ordered
table (matching Node exactly) means tracking insertion order across BOTH
stores as one sequence — a real fix, not a quick one, and out of scope for
the increment that first makes hybrid shapes representable at all.
**Tested by:** the wasm emitter unit test (declared-then-overflow order,
pinned directly, including the integer-like-first rule within the overflow
half); no corpus program can pin the Node-DIVERGENT order — a corpus
program's output must match Node byte-for-byte by definition, so a program
exercising this exact split would fail the differential on every lane.

**Amendment (increment 17, index-signature records): `__proto__` is an
ordinary own key here, not the prototype accessor.** A dynamic-keyed write
naming `"__proto__"` — `r["__proto__"] = v` — stores an ordinary overflow
entry keyed `"__proto__"` on every lane here. Node instead routes the
bracket write through `Object.prototype`'s `__proto__` ACCESSOR: assigning
a non-object, non-null value is a silent no-op (the setter's own contract),
so no own property named `"__proto__"` is ever created there. Measured on
Node 24.18: `interface U { [k: string]: number }`, `const r: U = {}; r.a =
1; r["__proto__"] = 99; r.b = 2;` — `Object.keys(r).join("|")` is `a|b` on
Node (the write to `__proto__` vanished) and `a|__proto__|b` here (C and
wasm agree byte-for-byte), and `JSON.stringify(r)` is `{"a":1,"b":2}` on
Node versus `{"a":1,"__proto__":99,"b":2}` here. The read side shows the
same split from the other direction: `r["__proto__"]` reads back the
stored value (`99`) here, while on Node it reads the `__proto__` accessor's
GETTER half — the object's actual prototype, `[Object: null prototype] {}`
when printed (C-lane measurement covers this too). This split is NOT new to
this increment — the identical divergence already existed at HEAD on the
plain dyn-object surface (an untyped `const r = {}; r["__proto__"] = 99;`
in a `.js` module measures identically: `a|b` / `{"a":1,"b":2}` on Node,
`a|__proto__|b` / `{"a":1,"__proto__":99,"b":2}` on C and wasm) — index-
signature records simply WIDEN an already-registered gap onto a second own-
key surface rather than opening a new one, the S027 pattern this entry
itself already follows for the ordering split above. **Rationale:**
neither the record overflow map nor the dyn object's own-key table special-
cases any key string; replicating `Object.prototype.__proto__`'s accessor
semantics would mean every dynamic-keyed write on every dyn/overflow
surface first checking the key against a reserved-name list, for a
JavaScript legacy accessor this compiler's object model has no equivalent
of. **Tested by:** the wasm emitter unit test (the record-overflow surface
pin lives beside the ordering pin above; the dyn-object surface has no
NEW pin since the gap predates this increment).

## S032 — A dynamic-keyed record read with no representable "missing" answer TRAPS *(wasm tier)*

`r[k]` on a record — hybrid (index-signature) or a signature-free shape
whose declared fields share one common type — checks declared fields
first, then (hybrid shapes) the overflow map. When neither answers, JS
returns `undefined`. This tier can only do that when the CHECKER'S result
type for the access can actually hold undefined: `unknown` (the checked-
dynamic box has its own undefined singleton) or an undefined-armed union
(`V | undefined`, from `noUncheckedIndexedAccess` or an explicit
annotation). When the checker claims a bare `V` with no undefined arm,
reading a missing key TRAPS instead of returning a value that violates its
own claimed type — S003's out-of-bounds stance (an array read past its
length can't answer `undefined` either, for the identical reason) applied
to the record surface.

Measured on Node 24.18 against the C lane: `interface Basic { known:
number; [k: string]: number }`, `const r: Basic = { known: 1 };
console.log(r.missing)` prints `undefined` on Node and traps here — C with
`scriptc: TypeError: record has no key 'missing' (typed 'number' — no
undefined is representable)` before aborting, wasm with a bare
`unreachable` (S007's trap-report bridge; the differential harness skips
the stderr comparison on a nonzero exit for exactly this reason — the two
lanes' trap TEXT differs, only the exit code and preceding stdout need to
match, and they do). This access is normally UNREACHABLE without an `as`
smuggle or `noUncheckedIndexedAccess` being off: `Basic`'s index signature
makes `keyof Basic` admit every string, so `r.missing` type-checks only
because the checker is (soundly, by TS's own design point) not tracking
that `missing` is absent.

**Rationale:** S003's array-OOB stance, extended to the one other place a
statically-typed read can be asked to answer a value its own type
forbids. **Tested by:** the wasm emitter unit test — the trap fires on the
non-representable path, and the SAME miss under an explicit `V | undefined`
index-signature annotation (the IDENTITY branch: the checker's result type
already carries its own undefined arm, so the emitter needs no union-WRAP
step) correctly returns the interned undefined arm instead of trapping.
`noUncheckedIndexedAccess` takes a DIFFERENT emitter path — the flag
answers a bare `V` index value by wrapping it in a fresh `V | undefined`
union rather than reading one already on the type — and while that path is
measured to answer the same way (follow-up task #8 tracks giving it its
own pin), no pin covers it today. No corpus program can pin the trap
itself for the same S003 reason.

## S033 — A dynamic-keyed write naming no declared field on a signature-free record throws *(wasm tier)*

`r[k] = v` reaches this construct for a shape with NO index signature only
when every declared field shares exactly one common type (the frontend's
own gate for accepting the write at all — SC1090 otherwise; the "mockable
module" pattern, `Record`-shaped closures dispatched by name, is the
corpus's live example, `tests/corpus/2470-mockable-module-shape.js`). Node
adds `k` as a new property when it names no existing one — ordinary
dynamic-object behavior. This tier's record is a monomorphic struct with a
FIXED field set; there is no slot to add. The write instead throws a
catchable `TypeError` reading `Cannot add property '<key>' to a
fixed-shape object`, and stores nothing.

Measured on Node 24.18 against the C lane (corpus 2470 exercises only the
success path, behind its own `Object.hasOwn` guard, so this needed a
dedicated probe): given a `{ tick: ... }`-shaped record and a `setKey`
helper doing `mocked[functionality] = implementation`, writing an
undeclared key runs silently on Node (adds the property) and throws
`TypeError: Cannot add property 'nope' to a fixed-shape object` here — C
and wasm agree on the exact text.

**Rationale:** the monomorphic-struct divergence every fixed-shape write
shares — this construct is simply the first place a COMPUTED key makes
"does this slot exist" a runtime question rather than one the checker
resolves at compile time (a literal-key `recordSet`/`fieldSet` never
reaches this path at all). **Tested by:** the wasm emitter unit test;
may-throw.ts's `!shape.indexValue` seed has required every native-lane
caller to check the pending-exception cell after this call since
index-signature records first shipped, so the wasm tier's implementation
needed no NEW may-throw work, only matching the existing contract.

## S034 — Wasm tier: typed-array/Buffer construction caps at 2^31 bytes *(wasm tier)*

`new Uint8Array(n)` / `new Uint32Array(n)` / etc. and `new T([...])` TRAP
(uncatchably) when the requested storage would be 2^31 BYTES or larger —
`elementCount * elementSize ≥ 2^31`. Node has no such ceiling at this size:
measured directly, `new Uint8Array(2147483648)` (exactly 2^31 bytes)
succeeds under Node 24.18 (a real 2 GiB allocation). This tier's `$bytes`
storage is one WasmGC `array (mut i8)`, whose length operand this backend
truncates with a SIGNED i32 conversion (`i32.trunc_f64_s`, which itself
traps outside `[-2^31, 2^31)`) — capping the guard at exactly that boundary
keeps every byte-address computation inside signed-i32 arithmetic the rest
of `typedarrays.ts` already assumes (index checks, `array.copy` lengths,
`byteLength`'s `len * esize` multiply), rather than chasing a second,
looser bound that would still need its own overflow story.

The guard is ONE private helper, `BytesBuilder.emitByteSizeGuard` in
`typedarrays.ts`, whose literal boundary constant — `2147483648` (2^31) —
IS this entry's registered cap by construction (one source of truth, not
two numbers that have to be kept in sync). It is called from the
construction sites that can produce an out-of-thin-air length — `newLen`
(the ToIndex'd f64 argument, unbounded before this check), `fromArrLit`
(the source `number[]`'s element count, itself already capped below 2^31
by arrays.ts's own vec-length guard, but a u32/i32/f32 element's
`esize=4` multiplier can still carry the BYTE size past 2^31 even though
the ELEMENT count alone would not, so it needs the identical check, not a
smaller one), and — round B3 — `concatLen` (`Buffer.concat(list,
totalLength)`'s explicit `totalLength` argument, the SAME "out-of-thin-
air numeric length" class as `newLen`, run AFTER `totalLength` passes
validateOffHelper's own catchable-RangeError check, per this section's
own "must run after any catchable-RangeError validation" rule). Plain
`concat` (no explicit length) computes its OWN total as the SUM of every
list element's length, but does so in **f64, not i32** — each element's
length is already < 2^31 individually (this same guard, at its own
construction site), but summing enough of them in i32 arithmetic could
wrap (two near-cap buffers wraps negative; three or more can wrap back to
a small positive, a SILENT miscompile risk if the summation itself were
the thing computing the final byte count) — accumulating in f64 instead
(exact up to 2^53, far past anything reachable through this tier's own
per-element cap) sidesteps the wraparound risk entirely, so `concat`
defers to `concatLen` with an f64 total that emitByteSizeGuard's own
check decides is oversized or not, never an accidental wraparound
deciding it. Every other bytes value (`slice`, `subarray`, `with`,
`toReversed`, `fillElem`, the same-elem `bytesNew` copy form) derives its
length from an already-valid receiver and never exceeds it, so these
three (`newLen`, `fromArrLit`, `concatLen`) are the COMPLETE set of
from-scratch NUMERIC-length allocation roots — guarding all three is
sufficient for the invariant `len * esize` never overflows i32 to hold
everywhere `byteLength` (or any byte-address arithmetic) reads it — this
"complete set" claim is scoped to that ONE invariant (an out-of-thin-air
NUMERIC length feeding a `$bytes` struct's `LEN` field directly, where a
wrapped allocation could pair with a stale, mismatched length and REPORT
a `byteLength` larger than its actual backing array — a silent structural
miscompile). It is not a claim that every `arrayNewDefault` call site in
`typedarrays.ts` is covered; see the stage-B amendment below for a
different category the guard deliberately does not extend to.

**Amendment (stage B, bytes io — the encoding surface):** `toStrHelper`/
`fromStrHelper` (`Buffer.prototype.toString(enc)` / `Buffer.from(str, enc)`)
add a SECOND category of from-scratch allocation, absent from stage A:
output sizes computed as a MULTIPLE of an existing string or bytes length
rather than an out-of-thin-air numeric argument — `toStr:hex`'s output is
`byteLen * 2`, `fromStr:utf8`'s worst-case scratch is `strLen * 3`, and
several other encodings compute their own exact or worst-case multiplier
the same way. None of these 12 sites — a lexical count of new
`arrayNewDefault` call sites added in this stage, confirmed against the
stage-A commit via `git diff` — call `emitByteSizeGuard`, and per the
reviewer's ruling this stays a PROSE fix, not a guard extension, because
the failure mode here is categorically different from the one the guard
exists to prevent: a `$bytes`/string VALUE feeding this tier already
carries a length under 2^31 (bytes, by S034's own cap; strings, by the
underlying WasmGC array's own i32 length field), so a multiplier like `×2`
or `×3` overflowing i32 is the THEORETICAL failure mode this reasoning is
built to survive — measured on the current toolchain, it never actually
gets exercised (see below): V8's own WasmGC array-length ceiling is LOWER
than the i32-overflow point for every site checked, so `array.new_default`
itself rejects the oversized request first, every time. Either mechanism —
i32 overflow, were a future engine's ceiling ever raised past it, or the
engine's own inherent ceiling, as measured today — resolves the same way,
because WasmGC arrays are bounds-checked by the engine on every access,
not raw linear memory: `array.new_default` rejects an oversized length
outright, or (in the i32-wrap scenario specifically, were it ever
reachable) a decode loop's own bounds-checked `array.set` would trap the
first time it wrote past an undersized array. Silent corruption is not
reachable through this path the way it was through `newLen`/`fromArrLit`'s
length-field mismatch, which is exactly why the guard is not extended
here — extending it would harden a failure mode that was never soft,
under either mechanism.

This still creates a NEW observable divergence from Node, registered here
per the S008 pattern (an uncatchable engine trap where Node has its own,
catchable, size-limit error). **All figures below are V8 implementation
limits measured on this toolchain (Node 24.18), not spec constants — a V8
upgrade can move them. The entry's claim does not depend on the exact
values, only on the engine cap binding before the i32 arithmetic on
current toolchains, and on every failure mode being an honest trap
regardless of which mechanism is the proximate cause.**

Measured directly — binary search on `array.new_default`, cross-checked
against the reviewer's own citation, both processes agreeing exactly: the
i8-array ceiling is 1,073,741,799 elements/bytes (`0x3FFFFFE7`); the
i16-array (string) ceiling is 536,870,899 units (`0x1FFFFFF3`). Both sit
just under 2^30 — roughly HALF of S034's own 2^31-byte guard boundary
(see the note added to the Rationale below). Driven through the REAL
`toStrHelper("hex")`/`newLen("u8")` path directly, not the abstract
ceiling alone: `byteLen` 268,435,443 / 268,435,444 / 268,435,449 all
succeed; 268,435,450 traps with the engine's own message, `requested new
array is too large`; a 300 MB buffer's `.toString("hex")` traps the same
way. There is no size at which this tier's `toString("hex")` silently
succeeds past its own ceiling, and no large "permissive middle zone" the
way an earlier draft of this entry implied.

Node's own ceiling (`buffer.constants.MAX_STRING_LENGTH` = 536,870,888,
measured) is LOWER still, so the actual divergence window is narrow and
exact, not the ~805 MB range this entry previously — wrongly — implied:
for `byteLen` in `[268,435,445, 268,435,449]`, five values, Node throws
(`Buffer.alloc(268_435_445).toString("hex")` throws immediately, message
`Cannot create a string longer than 0x1fffffe8 characters`, `code:
"ERR_STRING_TOO_LONG"`) while this tier still succeeds; at
`byteLen ≥ 268,435,450` both sides fail — Node catchably, this tier by an
uncatchable engine trap. THAT boundary, not a theoretical i32-overflow
point, is where the real divergence sits. **Correction to the reviewer's
citation:** the Node error is a plain `Error`, not a `RangeError` —
measured directly (`e.constructor.name === "Error"`, `e instanceof
RangeError === false`, `e.name === "Error"`); the reviewer's message text
was exact, the class was not.

`fromStr:utf8`'s worst-case scratch (`strLen * 3`) hits the SAME i8
ceiling, at `strLen ≥ 357,913,934` (`1,073,741,799 / 3 = 357,913,933`
exactly, the largest `strLen` that still fits — computed and independently
re-derivable from the measured i8 ceiling above, not a separately-cited
figure). This entry's earlier `715,827,883` figure was the i32-overflow
point, which the engine ceiling makes UNREACHABLE on this toolchain — it
never actually fires. **Tested by:** nothing, deliberately, the same call
S008 makes — no corpus program can sit anywhere near these thresholds
without a multi-hundred-megabyte-to-multi-gigabyte string or bytes value,
which is the same "already extreme" reasoning this entry's original
rationale gives for the construction cap itself.

**Rationale:** an engineering limit of this tier's representation, not a
deliberate semantic stance the way S003's typed-array-OOB amendment is —
Node really does allow (memory permitting) requests past this boundary,
and a program relying on that is depending on gigabytes of storage either
way (the same "real programs in this zone are already extreme" reasoning
as S008's size cap). Without the guard, the wasm-tier failure mode is
worse than a trap: `elementCount * esize` computed in i32 arithmetic AFTER
an incidental `i32.trunc_f64_s` (which only traps for element counts, not
byte counts) silently WRAPS mod 2^32, producing a byte-mismatched
allocation smaller than `byteLength` then reports — a miscompile, not an
honest failure, which is what this entry exists to rule out.

The guard's own explicit trap is not the only thing standing in this
range, and describing "a legal value up to 2^31 bytes" undersells it:
measured on this toolchain (Node 24.18's V8, a WasmGC implementation
limit, not a spec constant — it can move on a future V8), the underlying
`array (mut i8)` storage has its OWN inherent length ceiling BELOW this
guard's 2^31 boundary — 1,073,741,799 bytes, roughly HALF of 2^31 — so for
byte sizes between that ceiling and 2^31, `array.new_default` itself
already traps before the guard's own f64 check would have been the
reason a program observes a failure. The guard's own trap is the
proximate cause only at/above 2^31 exactly, where its check fires first,
ahead of ever attempting the allocation. This does not change what the
guard is FOR — it still makes the length-argument failure deterministic
and rules out the length-field-mismatch miscompile at the boundary that
matters (`i32.trunc_f64_s`'s own wrap point) — only which trap a program
actually observes for requests below 2^31 but above the current engine
ceiling. **Tested by:**
the wasm emitter unit test pins the trap side through `newLen` (a length
whose byte size is exactly the 2^31 boundary); a second, direct-
ModuleBuilder test pins the SAME guard reached through `fromArrLit` — a
fake `vec(f64)` struct whose `LEN` field claims 2^29 elements (×4 bytes =
exactly 2^31) over a REAL backing array of length 0, since the guard reads
only `LEN` before ever touching the backing array, so this exercises the
real instruction sequence without an actual multi-GB allocation. The
just-under-GUARD-cap path is deliberately untested on both roots — and,
per the note above, a REAL just-under-2^31 request would now be expected
to fail anyway, via the engine's own lower ceiling, before ever reaching
the guard's own boundary — the same call S008 makes: a corpus program
cannot exercise a multi-hundred-megabyte-to-multi-GB memory appetite
either way.

## S035 — Pooled-Buffer `byteOffset` is always 0, where Node's is a nondeterministic pool offset *(wasm tier)*

Node allocates `Buffer.from(...)` and `Buffer.allocUnsafe(...)` out of a
shared, per-process pool (a `Buffer.poolSize`-sized backing `ArrayBuffer`
— 65536 bytes, measured on Node 24.18 — that successive small allocations
carve slices from), so their `.byteOffset` answers the CURSOR POSITION
into that pool at allocation time — a value that climbs across calls
within one process and resets to 0 when a fresh chunk starts. It is
HISTORY-DEPENDENT, not merely varying: two Node 24.18 processes each ran
`Buffer.from([1,2,3])` twice as their first pooled allocations and
measured DIFFERENT second offsets (`0` then `16` in one process, `0` then
`8` in another) — the cursor's step depends on allocation state the
program neither sees nor controls.
`Buffer.from("abc")` is pooled too — stage B relevance: `buffer.fromStr`'s
eventual pooling story, if any, inherits this same divergence. `Buffer.alloc(...)` and
`new Uint8Array(...)` do NOT pool — both measured `0` on every call,
matching this tier's answer for them already (`bytesB.byteOffset()` on an
OWNING, non-view bytes value is always `0`, since `off` starts at 0 and
only view construction (`subarray`) ever advances it).

This tier never pools: `Buffer.from`/`Buffer.allocUnsafe` allocate their
own storage exactly like `Buffer.alloc`, so their `byteOffset` is always
`0` here, unconditionally — a real, permanent divergence from Node for
these two constructors specifically (not merely "untested"; Node's answer
for them is `0` only when the allocation happens to land at a chunk start,
an accident of prior allocation history the program cannot control).

**The divergence is BOUNDED, not universal.** Node's pool only serves
allocations strictly BELOW `Buffer.poolSize >>> 1` (`65536 >>> 1` =
32768 bytes); at or above that size Node allocates its own buffer, sized
exactly to the request, exactly like this tier always does. Re-measured
independently on Node 24.18 (a second process, per this project's
two-measurement standard for register numbers — the earlier 8-KiB
misstatement in this same entry is why): `allocUnsafe(32767)` pools
(`byteOffset` nonzero, `.buffer.byteLength` 65536); `allocUnsafe(32768)`
and `allocUnsafe(32769)` both own their buffer (`byteOffset` 0,
`.buffer.byteLength` exactly the requested size); `Buffer.from("x".repeat(32768))`
owns its buffer (`byteOffset` 0, `.buffer.byteLength` 32768, matching
this tier exactly) where `Buffer.from("x".repeat(32767))` pools
(`.buffer.byteLength` 65536 — even though ITS `byteOffset` happened to
read `0` this run, being the first slice of a fresh pool chunk: the
RELIABLE pooled/own signal is `.buffer.byteLength` equalling
`Buffer.poolSize` vs. the exact request, not `byteOffset` alone, which
can coincidentally be `0` either way). Stage B consequence: `buffer.fromStr`'s
results diverge on `byteOffset` only for encoded output STRICTLY BELOW
32768 bytes; a program printing `byteOffset` of a `Buffer.from(largeString,
enc)` result at or above that size is already Node-exact here, and
stage-B tests should not assume the whole surface diverges just because
short-string cases do.

**Rationale:** implementing Node's pool would mean modeling a SECOND,
shared allocator with its own chunk-boundary and remnant-fragment rules
purely to make one property (`byteOffset`) match a value that is itself
NONDETERMINISTIC even under Node — which is also why no corpus program
could pin Node's side of this without being flaky against the real Node
oracle it differentials against (the S008-style "why no corpus pin"
argument: the divergent value isn't just hard to reach, it doesn't HOLD
STILL on the reference implementation either, so byte-exact differential
testing is not merely impractical here but definitionally impossible).
Pooling exists in Node as a GC-pressure optimization with no OTHER
observable effect (reads/writes/length/content are unaffected — only the
numeric `byteOffset` and the fact that two small buffers may share one
underlying `ArrayBuffer`, itself unobservable without `.buffer` identity
comparison, a surface this tier doesn't expose). **Tested by:** the wasm
emitter unit test's bytes validate-sweep prints `a.byteOffset` for a
`Buffer.from(...)`-constructed value and pins `0` — that assertion is
OUR answer, not Node's, and is commented as such with this citation so
the test does not silently claim a Node-parity it does not have.

## S036 — A NaN's bit pattern depends on its PROVENANCE, on both Node and this tier — mirrored by folding at the SAME (measured) boundary V8 folds *(wasm tier)*

A NaN value's byte pattern is not one fixed thing on Node itself — it
depends on where the NaN came from and, per spec, is allowed to depend on
it. This is not implementation sloppiness: the WebAssembly spec's
"NaN Propagation" rule (Execution → Numerics) states it outright — for a
floating-point operator producing a NaN result, **the sign is
non-deterministic**; the payload is canonical when every NaN INPUT (if
any) already carried a canonical payload — which trivially includes the
no-NaN-input case (`0/0` has no NaN operands at all) — and is otherwise
picked non-deterministically among arithmetic NaNs (only the top payload
bit fixed at 1). `fneg`/`fabs`/`fcopysign` are the sign-preserving
exceptions; ordinary arithmetic (`add`/`sub`/`mul`/`div`/`rem`) is not.
So the SAME operation, `0.0 / 0.0`, is spec-licensed to produce EITHER
sign — V8's own wasm executor and V8's own JS interpreter are each
individually spec-conformant even when they pick opposite signs for the
identical computation, because the spec never promised they'd agree.

**Measured boundary (Node 24.18, V8, x86_64), via `writeDoubleBE`:**

| class | expressions | bytes (f64) |
|---|---|---|
| FOLDS → canonical | `0/0`, `0.0/0.0`, `(0)/(0)`, `-0/0`, `0/-0`, `0%0` | `7ff8000000000000` |
| FOLDS → canonical, recursive | `(1/0)-(1/0)`, `(1/0)*0` — a literal-DERIVED `Infinity` is a foldable intermediate | `7ff8000000000000` |
| FOLDS → canonical, the `NaN` global | `NaN`, `NaN+1`, `NaN*2` | `7ff8000000000000` |
| does NOT fold → hardware | `0*Infinity`, `Infinity-Infinity`, `Infinity/Infinity`, `Infinity*0` — the `Infinity` GLOBAL does not fold, unlike a literal-derived Infinity | `fff8000000000000` (sign bit SET on this x86_64 build — non-deterministic per spec, could differ on another host/engine build) |
| does NOT fold → hardware, variable lookthrough | `const z = 0; z / z` and every param/element/field form | `fff8000000000000` |
| `**` / `Math.pow`'s OWN returned NaN — board #158, FIXED | `(-2) ** 0.5` and the negative-base / non-integer-exponent family: Node's path makes this NaN at run time (V8's `sqrt(x + 0)` for 0.5, glibc's `(x - x) / (x - x)` otherwise), so it is the machine's invalid-operation NaN | Node `fff8000000000000`; this tier computes it the same way, `(x - x) / (x - x)` at run time, and answers `fff8000000000000` too (the Math-the-same unit; `packages/compiler/test/wasm-pow-u0.test.ts` R17, `math-ieee754.test.ts` EXACT pow and NAN). A LITERAL-only `**` folds (the rows above), as Node folds it: `(-8) ** 1.5` is `7ff8000000000000` on Node and every lane, and so is its negation `-((-8) ** 1.5)` — a unary minus over a folded operand folds with it, on every lane (`backend/float-fold.ts` foldNegation; `-(0/0)` is `7ff8…` too), while `-NaN` and `-(NaN + 1)` read the global and stay run-time negations (`fff8…`) |
| read from existing bytes | `buf.readDoubleBE(0)` written back unchanged | whatever bits were read (exact echo, sign/payload preserved) |
| string-derived (STRUCK — see below) | `Number("x")`, `parseFloat("x")`, `+"x"` | N/A — refuses in-tier |
| **overflowed source literal — REGISTERED RESIDUE** | `1e999 - 1e999`: a decimal literal whose VALUE overflows to `Infinity` at parse time | Node: `7ff8000000000000` (V8 folds it); this tier: `fff8000000000000` (our leaf-Infinity-poisons rule does not distinguish it from the `Infinity` global) — **DIVERGES** |

The "does NOT fold" row for the `Infinity` global is the arbitrary-
looking but ORACLE-CONFIRMED half of this boundary: `Infinity` and `NaN`
lower to the exact same IR shape (a bare `numLit`, `lower-exprs.ts`) with
no provenance marker distinguishing "the global" from "a literal-derived
value of the same magnitude" — yet V8 folds `NaN`-involving expressions
and does NOT fold `Infinity`-involving ones. Re-measured independently
this round (own probe, agreeing with the reviewer's table on every row).

**The overflowed-literal row is a genuine, currently-unresolved
divergence, not merely an untested axis.** `1e999` is SOURCE SYNTAX — a
numeric literal token whose decimal value exceeds the f64 range — and V8
folds `1e999 - 1e999` to the canonical NaN, exactly like the ordinary
literal-arithmetic rows above, NOT like the `Infinity`-global rows. But
at the IR level this tier receives, an overflowed literal and the
`Infinity` global are the SAME THING: both lower to a bare `numLit` with
value `Infinity` and no further marker (`lower-exprs.ts`), so this tier's
leaf-poisons-on-Infinity rule cannot tell them apart and treats `1e999`
the same as the `Infinity` global — incorrectly, for this one row. The
distinction V8 is actually making lives at a RAW-SOURCE level (was this
token literally digits-and-exponent syntax, or an identifier lookup) that
this tier's IR does not preserve past lowering; fixing it would mean
carrying a provenance bit through `numLit` specifically for this case,
which is frontend surgery out of scope for this fix round (board #90
tracks the residue; #22 — this entry's own rewrite task — is closed). **Measured against the differential harness's
REAL oracle invocation specifically — `node --experimental-transform-types`
(`tests/harness/wasm-differential.test.ts`), not a third-party
transpiler:** a naive verification via `tsx` (the popular esbuild-backed
TS runner) gives `fff8000000000000` for this SAME expression — the WRONG
answer, i.e. NOT what the actual differential census oracle produces —
because esbuild's own bundling/constant-folding pass does not replicate
V8's literal-vs-identifier folding distinction. This is exactly why this
entry insists on citing the harness's own oracle command rather than "a
Node-family tool" generically: two different, both-plausible "run this
TS file" tools disagree with each other on this one row, and only one of
them is the actual oracle this project holds itself to.

**What this tier does.** `writeDoubleBE`/`writeFloatBE`
(`typedarrays.ts`'s `writeNumFloatHelper`) are a plain bit-exact
passthrough — no canonicalization at the write site — matching the
"does not fold" and "read from existing bytes" rows directly. The FOLDS
rows are handled upstream, at the emitter's `emitBin`/`tryFoldFloatConst`
(`emitter.ts`): a RECURSIVE fold over float arithmetic (`+ - * / % **`)
whose leaves are numLits, mirroring the measured boundary exactly —
- a `numLit` folds to its value, UNLESS that value is exactly
  `Infinity`/`-Infinity` reached AT A LEAF (a direct operand position):
  reaching Infinity there poisons the containing expression, reproducing
  "the `Infinity` global doesn't fold" without needing a provenance
  marker the IR doesn't carry.
- a `bin` node folds if BOTH operands (recursively) fold — this is what
  lets a literal-DERIVED Infinity (`1/0`, a computed RESULT, not a leaf)
  re-enter the fold pool for `(1/0)-(1/0)`, even though a bare `Infinity`
  leaf cannot: the poison rule only fires at a direct numLit leaf.
- a unary `-` over a foldable operand folds too (`-(1/0)`-shaped
  expressions); `-0`/`-Infinity`/`-NaN` never reach this arm because the
  frontend already pre-folds unary-minus directly over a numLit operand
  into a signed numLit (`lowerPrefixUnary`).
- anything else (varRef, calls, ...) does not fold: no constant
  propagation, no variable lookthrough.

A NaN result of the fold gets the CANONICAL bit pattern substituted
EXPLICITLY (never the fold computation's own bits): folding runs inside
the compiler's own V8 process, itself "runtime" from the fold's
perspective, so an unguarded `0/0` computed there would land on the
hardware pattern, not canonical — exactly the trap this entry's spec
citation explains.

**Struck: string-derived NaN provenance.** `Number("x")`/`parseFloat`/
unary `+` over a non-numeric string all route through `num.fromString`
(`libCall`), which REFUSES on this tier today — there is no in-tier path
that can produce a string-derived NaN to verify. Revisit this row if/when
`num.fromString` lands.

**Revisited: Math-function NaN provenance (the Math unit, S100).** This
paragraph was struck while every `Math.*` call refused on this tier. They
compute now (under `--dynamic`), and the third NaN-payload pattern is
measured: `Math.log(-1)` is `7ff4000000000000` in Node — ieee754.cc's
`std::numeric_limits<double>::signaling_NaN()`, not libm's — and the tier
returns the same bits, as it does for every NaN a Math member returns
(S100 lists them, and registers the one place the bits part: a signaling
NaN stored into a `number[]`). `Math.pow`'s own NaN stays the registered
`**` row above.

**The registered risk — three items: one KNOWN divergence, two axes not
currently measured to diverge:**
0. **KNOWN: the overflowed-literal row above.** `1e999 - 1e999` and any
   equivalent expression built from a source literal that overflows to
   `Infinity` gives this tier's hardware pattern where Node gives
   canonical — a real, currently-unfixed residue of the leaf-Infinity-
   poisons rule, not a hypothetical. Out of scope for this fix round
   (frontend surgery to carry literal-vs-identifier provenance through
   `numLit`); tracked as board #90 (filed at the increment-22 close —
   the entry's only disposition citation, in the body paragraph above,
   pointed at the closed rewrite task #22, leaving this residue
   untracked).
1. **Our folding boundary vs. V8's, otherwise.** This tier's boundary is:
   literal IR operands, recursively, with Infinity-as-leaf poisoned — an
   exact, testable rule. V8's is whatever V8's parser/optimizer actually
   does, independently measured per row above. Every row this round
   tested matches EXCEPT the overflowed-literal row (item 0); a row this
   entry does not enumerate (the struck rows above, or some future
   syntactic form) could still diverge and would need its own measurement
   before being trusted.
2. **The spec's own sign-nondeterminism.** Because NaN sign is
   spec-legal to vary by engine/build/host, THIS tier's answer for the
   "does not fold" rows is only guaranteed to match Node's TODAY, on
   THIS toolchain (Node 24.18, V8, x86_64) — both sides currently choose
   the SAME hardware pattern for a genuinely-computed NaN because both
   run on the identical underlying V8/hardware. If a future V8 build (or
   a differently-configured host, e.g. ARM) flips which sign its
   OWN wasm executor picks independent of its JS interpreter, the
   differential census would fail VISIBLY on the "does not fold" rows —
   this entry is that failure's explanation, not a guarantee it cannot
   happen. The FOLDS rows are immune to this risk: canonical bits are
   substituted explicitly, never computed.

**Cross-reference to board item #6.** The C+LLVM backend's Map storage
has its own, separately-tracked NaN-key bug (board #6). Node's Map/Set
use SameValueZero, under which every NaN is one key regardless of payload
bits, so a NaN key's stored bits are unobservable AS a key on any
backend; they only become observable once they cross a byte-exposure
boundary like `writeDoubleBE`, at which point THIS entry's provenance
rule governs the answer (whatever bits the key carried get echoed, per
the "read from existing bytes" row). No contradiction — different layers.

**Tested by:** `wasm-emitter.test.ts` — a dedicated boundary-table test
pinning EVERY fold/no-fold row above via an in-process Node diff (not a
hardcoded hex string, so it travels to a future toolchain that moves the
hardware pattern) plus an explicit canonical-bits assertion on the fold
rows specifically; a literal-folding behavioral test (parity across all
six ops including the previously-refused literal `**` case, plus a `-0`
sign-preservation check); a byte-level float-kinds test pinning the
literal-`0/0` fold and the crafted/read-back echo case; an LE-vector test
(f64 and f32, including the f32 signaling-quiets-but-preserves-payload
round trip — a hardware artifact of the f32↔f64 conversion path, Node-
exact, not a divergence); a dedicated runtime-NaN test using an array-
element division specifically to avoid the fold path (covers BE/LE,
f32/f64); and an opcode-count test proving a variable-sourced division
still emits a real `f64.div` (0xa3) rather than being folded away, by
diffing raw byte counts between two otherwise-identical compiled
binaries. Corpus program `1660-buffer-read-write-num.ts` pins the
literal-fold case end-to-end through the differential harness
(`tests/harness/wasm-differential.test.ts`'s `TIER_FLOOR`).

## S037 — A `Buffer` crossing `unknown` through the generic path renders as `Uint8Array` on the far side, on every lane, including at construction *(wasm tier, shared with the LLVM lane)*

Node distinguishes `Buffer` from a plain `Uint8Array` by the constructor
that built it — `Buffer.isBuffer`, `instanceof Buffer`,
`.constructor.name`, `String(x)`/`x.toString()` (Buffer decodes UTF-8;
Uint8Array joins elements with commas), `util.inspect` (`<Buffer 01 02>`
vs `Uint8Array(2) [ 1, 2 ]`), and `JSON.stringify` (`{"type":"Buffer",
"data":[...]}` vs `{"0":1,...}`) all differ, all measured directly
against Node 24.18. This tier's dyn tree models the distinction as a
single flag bit on the BYTES payload (`$dynBytes.isBuffer`, increment 18
stage C) and all FOUR consumer arms that need it — `kindName` (the
"Received an instance of X" error text), `toStr` (`String()`),
`json.ts`'s `putDyn` (`JSON.stringify`), and `inspect.ts`'s `dyn` walker
(`util.inspect`/`console.log`, via the dedicated `bufferForm` hex
renderer) — branch on it correctly. The flag itself, however, cannot be
RECOVERED at the one generic construction site.

**The root cause: `Buffer` and `Uint8Array` are ONE IR type before
`dynFrom` ever runs, and the constructor is interned by that type, not by
call site.** `bytes<u8>` is the IR's single runtime representation for
both (`types.ts`'s `isStdlibInterface("Uint8Array")` and the
`Buffer`-provenance check both resolve to `bytesOf("u8")`; nothing in the
IR type carries which source interface produced it). The wasm emitter's
`dynFrom` producer for a given IR type is a CACHED, type-keyed helper
(`emitDynFromBody`'s `case "bytes":`, interned once per element kind) —
every `bytes<u8>` value in the whole module, from every call site, shares
the SAME one function. Even if the IR *did* somehow know at ONE call site
that its source was a `Buffer`, the interning discipline would still
average that fact away across every other `bytes<u8>` crossing in the
program, because there is exactly one dynFrom-for-bytes-u8 function to
share. The fix has to move the distinction into the type (or a sibling
marker) the interning keys on — a call-site patch cannot survive it.

**Construction is EQUALLY indistinguishable — this is not only a
crossing-site gap.** `new Uint8Array(n)` and `Buffer.alloc(n)` both lower
to the identical `bytesNew` IR node (`nodes.ts`) with `elem: "u8"`, and
the wasm emitter's `case "bytesNew":` (emitter.ts) calls the SAME
`bytesB.newLen("u8")` helper for both — no branch, no flag, nothing
observes which source spelling the program used. This means the fix point
for S037 is genuinely upstream of `dynFrom` — even a `dynFrom` node
willing to carry a provenance argument has nothing to read it FROM, since
construction itself already discarded the distinction. Recovering the
flag needs a marker planted at `bytesNew` (or earlier, at the declaration
site) and threaded through every place a `bytes<u8>` value can flow
before it reaches a crossing — tracked as board item #25, filed with this
root-cause trace attached.

At the generic crossing site — a bare `const u: unknown = someBytes` with
no hardcoded call-site knowledge of the source — the wasm emitter
therefore pins the flag to `false` (plain `Uint8Array`) unconditionally,
so a genuine `Buffer` that crosses through this path answers
`Uint8Array`-flavored on every one of the four consumer surfaces once
observed back through `unknown`: `String(buf)` joins elements with commas
instead of UTF-8-decoding them; `util.inspect(buf)` prints the array-
grid form (`Uint8Array(N) [ ... ]`, with the depth cutoff and grouping
that implies) instead of the hex `<Buffer aa bb>` form (which is neither
depth-limited nor grid-grouped); `JSON.stringify(buf)` answers the
numeric-keyed object form instead of `{"type":"Buffer","data":[...]}`;
and `kindName`'s error text says "Uint8Array" where Node would say
"Buffer".

**This is not a new divergence the wasm lane introduces.** The LLVM lane's
own generic crossing site has the identical shape: `dyn.ts`'s `case
"bytes":` (backend/llvm/dyn.ts) calls `scr_dyn_new_bytes_copy`
unconditionally — never `scr_dyn_new_buffer_copy` — for every `bytes<u8>`
value regardless of its source. Only hardcoded, special-purpose call sites
that already know a value's flavor structurally (for example the stream-
chunk delivery path, `scr_dyn_invoke.c`'s `recv->buffer ? ... :
...`) get this right; the *generic* `unknown`-crossing surface has never
been able to answer it, on any lane, because the information does not
exist upstream of the crossing — construction itself already lost it,
identically on every backend (the previous paragraph's `bytesNew`/
`Buffer.alloc` finding is a frontend/IR fact, not a wasm-specific one).
The wasm lane's flag-aware consumer arms are new (this increment); the
upstream blindness they inherit is not.

**Why pin `false` instead of refusing.** A loud refusal at every `bytes<
u8>` → `unknown` crossing would take back all of R2's dyn-crossing work
for the overwhelmingly common case (plain `Uint8Array`, and any `Buffer`
crossing that a program never observes through a Buffer-specific surface
on the far side) to guard a narrower case this tier cannot yet detect
either way. Pinning `false` is the LLVM lane's own existing choice, not a
new one invented for wasm — see above.

**No corpus program can exercise Buffer-flavor through the generic
crossing and pass, on ANY lane — this is structurally clean, not
cherry-picked.** Because the blindness is shared by wasm, LLVM, and C
alike (the previous two sections), a corpus program that crossed a real
`Buffer` through the generic `unknown` path and then observed a
Buffer-flavored surface would print the WRONG, Uint8Array-flavored text
on every lane identically — which means it would never have been added as
a passing corpus program in the first place, on any backend, at any point
in this project's history. The corpus's silence on this exact case is not
an oversight this entry is patching after the fact; it is what a
byte-exact-against-Node differential harness necessarily produces when
every lane shares one blind spot. `916-unknown-bytes.ts` DOES cross a
`Buffer` through this exact generic path (`const buf = Buffer.from("hi");
const ub: unknown = buf;`) but only reads `.length`/`[i]` off the
extracted value — never `String()`, `util.inspect`, `JSON.stringify`, or
a constructor-name check on that specific value — which is exactly the
shape "a corpus program that never looks" has to take. A future corpus
program that DID observe a Buffer-flavored surface after a generic
`unknown` crossing would fail the differential visibly (wrong text, not a
crash) on every lane, which is how this gap would be caught if it ever
became reachable.

**916's own comment already claimed this entry existed — it didn't, until
now.** The corpus file's header (lines 35-38) reads: "String() of an
unknown holding a BUFFER joins the elements like a Uint8Array — Node
decodes UTF-8 there; the checked-dynamic tree cannot tell the two apart.
SEMANTICS.md documents it." That claim was FALSE when written — no such
entry existed anywhere in this register, checked directly before this
entry was added. This is the honest history: S037 is what retroactively
makes that comment true, not a citation the comment was correctly
anticipating. The comment now points at a real numbered entry (updated to
say "S037" explicitly) instead of a promise nothing had kept yet.

**The fix is frontend work, not backend.** Recovering the flag means
carrying Buffer-vs-Uint8Array provenance from `bytesNew` (or the
declaration site) through the IR to the `dynFrom` node that boxes it — a
distinct IR-level marker, since `bytesOf("u8")` itself cannot carry one
without widening every other `bytes<u8>` consumer's match arms. Tracked
as board item #25. Until that lands, this entry is the registered
explanation for the gap; the wasm emitter's per-arm flag handling is
already correct GIVEN an accurate flag — the gap is entirely upstream of
it, and once board #25 lands, wiring the recovered flag through at the
one `dynFrom` construction site is the whole remaining change on this
side of the boundary.

**Tested by:** nothing pins the gap itself (a test asserting "a Buffer
crossing `unknown` wrongly prints as Uint8Array" would be a test that the
tier is broken, not that it works) — this entry is the registration.
The flag-TRUE branches of all four consumer arms ARE tested, though —
directly at the builder level (constructing a `$dynBytes` payload with
`isBuffer=true` by hand, bypassing the frontend's unreachable-today path)
against Node's measured Buffer-flavored forms, so the day board #25 wires
a real provenance flag through, these arms are proven correct in advance
rather than merely "written and hoped." `wasm-bytes-flag.test.ts` has the
builder-level flag-true assertions (kindName, toStr, json.ts's
stringifyDyn, and inspect.ts's dyn walker, each checked both ways);
`wasm-emitter.test.ts` has the flag-false-but-divergent assertion (for a
real Buffer that DID cross generically) that pins THIS tier's answer with
an explicit citation to this entry, never Node's.

**Amendment (INC-27 U5): the reverse face — the clone of a Buffer-typed
value renders as a Buffer.** In Node `structuredClone` of a `Buffer`
answers a plain `Uint8Array` (a Buffer's clone keeps its bytes but not its
Buffer-ness: `util.inspect` prints `Uint8Array(2) [ 104, 105 ]`). The
front end types `structuredClone<T>(value: T): T`, so when TypeScript
types the argument as `Buffer` the result is checked back to the argument's
own `bytes<u8>` type, and every typed surface renders it by that static
type — `util.inspect` and `console.log` print `<Buffer 68 69>` (measured
on every lane), where Node's clone prints `Uint8Array(2) [ 104, 105 ]`;
`String()`, a template literal, `JSON.stringify` and a string-typed
argument reach existing named fences instead (SC2020 / SC1090, measured on
every lane).
Measured on every lane: wasm, C and LLVM print `<Buffer 68 69>` alike.
The dynamic-value clone is right: a Buffer held in `unknown` (a stream
chunk passed through an untyped callback) clones to a value that prints
`Uint8Array(2) [ 104, 105 ]`, as Node's does, because the clone drops the
flag this entry describes. The root cause is this entry's own — the IR has
one type for both, so the static type the front end gives the result
cannot say "Uint8Array". Board #206 owns the fix;
`wasm-dynsmalls-u5.test.ts` pins this tier's answer (row R42c) beside the
Node-exact dynamic-value row (R42b). The entry count is unchanged.

**Amendment (INC-29 U1): `slice()` through a dynamic value follows the flag exactly.** On the wasm lane a checked-dynamic `slice()` of bytes (built in node:net modules — S087 (i)) is `Buffer.prototype.slice`, a VIEW, when the payload carries the Buffer flag (a `'data'` chunk), and `TypedArray.prototype.slice`, a COPY, when it does not. A `Buffer` that crossed the generic path carries no flag (this entry), so it slices as the Uint8Array it reads as everywhere else on the far side: a copy, where Node's Buffer slice is a view — a write through the slice is not seen in the source, nor the reverse (`pass(Buffer.from("abcd")).slice(1, 3)[0] = 65` leaves the source's byte 98 here; Node reads 65). Board #25 (the provenance marker) retires this with the rest of the entry. **Tested by:** N1-REG-03 (`tests/harness/wasm-differential.test.ts`), with Node's answer in a comment beside it, and the corpus program 2640 (a slice that is only read, the same on both).

## S038 — A `Buffer | string`-shaped union's `.toString()` treats the bytes arm as Buffer UNCONDITIONALLY, even when the runtime value is a plain `Uint8Array` *(wasm tier, shared with the LLVM and C lanes)*

Node's `.toString()`/`String(x)` on a bytes value depends on the ACTUAL
constructor: `Buffer.prototype.toString()` UTF-8-decodes (measured:
`Buffer.from([0x61,0x62,0x63]).toString()` is `"abc"`); a plain
`Uint8Array` inherits `Object.prototype.toString`'s array-like path and
joins elements with commas (measured: `new Uint8Array([0x61,0x62,0x63])
.toString()` is `"97,98,99"`) — two genuinely different renderings, not a
formatting nuance. `lowerUnionToStringCall` (lower-calls.ts) admits a
union arm into the shared per-union ToString helper whenever it is
`bytes<u8>`, with no isBuffer test, because — same root cause S037 traces
for the dyn-crossing boundary — `Buffer` and `Uint8Array` are ONE IR type
(`bytes<u8>`) with no marker distinguishing them; nothing survives to
read a provenance bit even if the call site wanted one. The per-union
`%w.u.toStr:<id>` helper (unions.ts, wired in increment 18 R3) therefore
renders EVERY bytes arm via the unconditional UTF-8 decode
(`bytesToStrUtf8`/`scr_bytes_to_str`), matching Buffer exactly and
diverging from Node for a plain-`Uint8Array` arm.

**Not a new divergence this round introduces.** The C backend's `sc_us_N`
generated switch (`emit-walkers.ts:219`) already calls
`scr_bytes_to_str` unconditionally for a union's bytes arm, with no
isBuffer branch — this stance predates increment 18 entirely. Wiring the
wasm lane's `%w.u.toStr` the same way (this round) makes wasm consistent
with the two lanes that already had this gap, rather than inventing a
third, independently-wrong answer.

**No corpus program can exercise the wrong case and pass, on any lane —
S037's argument applies unchanged.** A program computing a genuinely
plain (non-Buffer) `Uint8Array` into a `Uint8Array | string`-typed
receiver and calling `.toString()`/`String()` on it would print the
WRONG, Buffer-flavored (UTF-8-decoded) text on C, LLVM, and wasm alike —
so it would never have passed the byte-exact-against-Node differential on
any backend, at any point, and the corpus's silence on this exact shape
is structural, not an oversight. The corpus's actual `Buffer | string`
union-ToString program (1566-child-duck-interface.ts) only ever
constructs the Buffer arm, which is why it passes cleanly under this
entry's stance.

**The fix is the same upstream frontend work S037 already tracks (board
#25):** carrying Buffer-vs-Uint8Array provenance through `bytesNew` into
the IR is the one change that would let `lowerUnionToStringCall` (and
`lowerConsoleInspectArg`/`lowerInspectCall`'s static Buffer gate, and
every dyn-crossing consumer S037 lists) discriminate correctly; nothing
in this union ToString path needs its own separate fix once that lands.

**Tested by:** nothing pins the wrong case itself, for the same reason
S037 gives — a test asserting the divergent answer would be a test that
the tier is broken, not that it works. `wasm-emitter.test.ts` pins the
CORRECT (Buffer) case — a `Buffer | string` union rendering both arms —
directly against Node, with an explicit citation to this entry for why a
future `Uint8Array | string` variant is not also asserted there.

## S039 — `yield*` suspended inside a delegation does not forward the outer generator's `.return()`/`.throw()` into the delegate *(frontend desugar, shared by all three lanes)*

Node's `yield*` fully delegates the consumer surface, not only `.next()`:
calling `.return(v)` or `.throw(e)` on the OUTER generator while it is
suspended inside a `yield*` first calls the DELEGATE's own `.return`/
`.throw` method — running the delegate's own `finally`/`catch` machinery —
and only propagates the resulting completion into the outer generator's
own `try`/`finally` afterward. Measured on Node 24.18.1 (two runs,
identical output both times):

```js
function* inner() {
  try { yield "a"; yield "b"; } finally { console.log("inner finally ran"); }
}
function* outer() {
  try { yield* inner(); } finally { console.log("outer finally ran"); }
}
const g = outer();
g.next();          // { value: "a", done: false }
g.return("RV");    // logs "inner finally ran", THEN "outer finally ran"
                    //   → { value: "RV", done: true }
```

With `.throw()` in place of `.return()` and no `catch` inside `inner`, the
same order holds (`inner finally ran` then `outer finally ran`) and the
SAME `Error` object propagates out of `g.throw()` to the caller — `inner`'s
own uncaught throw, forwarded verbatim, not swallowed or re-wrapped. When
`inner` DOES catch (a `catch` clause around its `yield`), the thrown value
is caught INSIDE `inner`, which may itself `yield` again — the delegation
is genuinely two-way, not a one-shot notification that the outer is
closing.

**This tier's `yield*` desugar cannot reproduce it — by construction.**
`lowerYieldStarStatement` (lower-generators.ts) desugars `yield* e;` into
a plain forwarding loop: `{ const %dele = <e>; let %dr = %dele.next();
while (!%dr.done) { %dr = %dele.next(<yield %dr.value>); } }` — the ONLY
operation it ever performs on `%dele` is `.next()`. The embedded `yield`
(inside `%dele.next(<yield %dr.value>)`) is an ordinary suspension point of
the OUTER generator like any other; a consumer `.return()`/`.throw()`
arriving there is just an injection at that state — the same GENRET/THROW
routing any other suspension point gets — so it unwinds the OUTER
function exactly as it would anywhere else, with no code path that reaches
back into `%dele` at all. The delegate is simply abandoned: never resumed,
never closed, its own pending `try`/`finally` at its own suspended point
never runs.

**All three lanes diverge identically.** `lowerYieldStarStatement` is a
FRONTEND desugar — the IR it emits is the input every backend (C, LLVM,
wasm) lowers, so this is not a wasm-specific gap; whichever lane first
implements generators inherits this exact stance from the shared IR. Not
only by construction: the reviewer compiled the same shape through the C
and LLVM backends and measured it directly (`lane-s039c.ts`, the bare
`g.return()` case, and `lane-s039b.ts`, the explicit-return-value variant)
— both native lanes print `outer finally ran` only, never `inner finally
ran`, the identical non-forwarding this entry describes for wasm.
`lane-s039b.ts` additionally shows the returned `{value, done}` PAIR still
agreeing with Node's `{"value":"RV","done":true}` on all three lanes
despite the non-forwarding — the divergence is confined to the delegate's
silently-skipped side effects, not the outer's own reported completion
value. The field ORDER match is via `genResultRecord`'s own
`declaredOrder: ["value", "done"]` (F4, S041), not an inherent per-lane
property — S041's own module-wide race (whichever construction reaches
the interner first) still governs it in principle, empirically confirmed
value-first on all three lanes as of increment 19 stage C-1, not
guaranteed unconditionally for every construction order. A companion Node-only measurement, `s039-identity.mjs`, confirms
the "forwarded verbatim, not swallowed or re-wrapped" claim above at the
object-identity level, not just by matching message text: a `.throw()`
forwarded from a non-catching delegate reaches the caller as the exact
SAME `Error` instance (`caught === sentinel` is `true`), which is the
stronger claim this entry's stance needs to eventually contrast against
once generator lowering exists.

**No corpus program can exercise the forwarding and pass, on any lane.**
A program observing the delegate's own `finally`/`catch` running (or not)
after an outer `.return()`/`.throw()` mid-`yield*` would print Node's
extra delegate-side output on Node and NOT print it here — identically on
every lane, since the gap sits upstream of all three backends — so such a
program could never have passed the byte-exact differential and could not
have entered the corpus. `2015-generators-yieldstar.ts` (the corpus's own
yield*-delegation program) exercises `.next()` forwarding, chained
delegation, and delegation into an exhausted generator, but never calls
`.return()`/`.throw()` on the outer generator while suspended inside a
`yield*` — exactly the shape "a corpus program that never looks" has to
take, confirmed by direct reading, not assumption.

**Not planned as a fix within this increment.** Closing it needs the
`yield*` lowering to recognize its own suspension points specially — an
injection landing on one of them would have to redirect into a genResume
call on `%dele` before continuing the outer's own unwind — a second kind
of delegation-aware state, genuinely new machinery beyond the finalizer
linearization increment 19 stage B builds for ordinary `try`/`finally`.
Left as registered debt.

**Tested by:** (written before increment 19 stage A built the generator
lowering; the "Pinned" paragraph below records the pins that landed at
the register close-out.) The Node-side claim above is independently
triple-measured: this entry's own inline repro, `inc19-probes/
probe-gen-ladder.ts`'s corner #11 (`11.delegate-log ["inner-finally"]`,
run twice, identical both times), and `inc19-probes/
s039-yieldstar-forward.mjs` (a third, separately-authored script) all
agree. `s039-yieldstar-forward.mjs`'s THIRD scenario — an outer
`.throw()` arriving while the DELEGATE has its own `catch` around the
suspended `yield`, so the delegate genuinely catches the injected error
and yields again (`{ value: "ic-caught-and-yielded-again", done: false }`)
rather than merely rethrowing or running a `finally` — is this entry's
strongest witness: a `finally`-only forward could in principle be
explained by some simpler unwind-notification mechanism, but a `catch`
binding the exact injected value and the delegate staying ALIVE
afterward is only possible if `.throw()` is a real re-entry into the
delegate's own suspended frame, exactly the two-way delegation Node's
spec gives `yield*` and this tier's desugar cannot reach. **Pinned** (the
increment 19 final unit's own citation read found this instruction
unfulfilled at the time): `wasm-statemachine.test.ts`'s "register
close-out: S039/S040 forward-instruction pins" describe block, the S039
test — a full-source `yield*`-delegation program, `.return()` injected
mid-delegation, asserting the CURRENT (non-forwarding) behavior directly,
the same way S037/S038 pin their gaps' correct-branch behavior; no
corpus program can pin the gap itself, per the previous paragraph.

## S040 — A consumer `return`/`throw` abandoning a `for-of` over a generator does not `IteratorClose` (only `break` does) *(frontend desugar, shared by all three lanes)*

Node's `for-of` protocol calls `IteratorClose` (`.return()` on the
iterator) whenever the loop body's completion is anything other than a
normal completion or a `continue` targeting the loop — this covers
`break` AND a `return` statement in the body AND an uncaught `throw` in
the body, not only `break`. Measured on Node 24.18.1 (two runs, identical
output both times) with a generator whose `try`/`finally` wraps its
yields, consumed by three separately-scoped loops that each abandon after
the first value:

```js
function* gen() {
  try { yield 1; yield 2; yield 3; } finally { console.log("finally ran"); }
}
function viaBreak()  { for (const x of gen()) { if (x === 1) break; } }
function viaReturn() { for (const x of gen()) { if (x === 1) return; } }
function viaThrow()  { try { for (const x of gen()) { if (x === 1) throw new Error("boom"); } } catch {} }
viaBreak();   // logs "finally ran"
viaReturn();  // logs "finally ran"
viaThrow();   // logs "finally ran"
```

All three abandonment shapes print `finally ran` identically. (A naturally
EXHAUSTED loop also logs it, but that is the generator's own function
completion running its `finally` as ordinary control flow, independent of
any close — the probe isolates the close-specific cases by stopping after
the first value in each of the three abandonment shapes above.)

**This tier's desugar closes on `break` only — by construction.**
`lowerForOfGenerator` (lower-generators.ts) desugars into:

```
{ const %gof = <iterable>; let %gdone = false;
  while (true) {
    const %gr = %gof.next();
    if (%gr.done) { %gdone = true; break; }
    const x = <extract %gr.value>;
    <body>
  }
  if (!%gdone) %gof.return();           // IteratorClose
}
```

The close is a plain statement placed AFTER the `while` — reached only
when control falls out of the loop normally (exhaustion setting `%gdone`
before its own `break`, or a `break` inside `<body>` that skips the
`%gdone = true` assignment but still falls to the same point). A `return`
or `throw` inside `<body>` unwinds the ENCLOSING FUNCTION (or the nearest
`catch`) directly, exactly as it would past any other `while` loop, and
never reaches the close statement at all. Reaching it for those two
completions would need the close wrapped in its own `finally` region —
machinery this desugar does not build.

**All three lanes diverge identically.** `lowerForOfGenerator` is a
FRONTEND desugar — every backend compiles the identical IR it emits, so C,
LLVM, and wasm inherit this exact stance uniformly; it is not specific to
whichever lane implements generators first. Not only by construction: the
reviewer compiled `lane-s040.ts` (the `viaBreak`/`viaReturn` pair) through
the C and LLVM backends and measured it directly — both native lanes print
`finally ran` for `break` (matching Node) and print NOTHING for `return`
(matching this tier's `break`-only stance, diverging from Node exactly as
this entry describes for wasm), the identical split on every lane this
tier implements today.

**No corpus program can exercise the wrong case and pass, on any lane.**
A program whose generator has an observable `finally` (or any other
release side effect at its suspension point) and whose consuming `for-of`
is abandoned via `return`/`throw` rather than `break` would print Node's
extra close-triggered output on Node and NOT print it here — identically
on every lane, since the gap sits upstream of all three backends — so such
a program could never have passed the byte-exact differential and could
not be in the corpus today. `2011-generators-forof.ts` (the corpus's own
for-of-over-generator program) exercises exhaustion, `break`, and
`continue` — all three the CURRENT stance already gets right — never a
`return`/`throw` abandonment, confirmed by direct reading; it does not
conflict with this entry.

**Not planned as a fix within this increment.** Making `return`/`throw`
also close would need the desugar to route abrupt loop exits through a
`finally`-like region that runs the close on every path out — real
machinery, not a quick patch, and out of scope for what increment 19 stage
0 registers. Left as registered debt.

**Tested by:** (written before increment 19 stage A built the generator
lowering; the "Pinned" paragraph below records the pins that landed at
the register close-out.) The Node-side claim above is independently
quadruple-measured: this entry's own inline repro; `inc19-probes/
probe-gen-ladder.ts`'s corner #12 (`12.break-closes ["gen-finally"]`,
`12.return-closes ["gen2-finally"]`, run twice, identical both times);
`inc19-probes/s040-forof-close.mjs` (a third, separately-authored script,
covering `break`/`return`/`throw`/exhaustion in one run); and `inc19-
probes/s040-close-vs-completion.mjs`, which closes the one gap the other
three share — none of them can tell "the generator's `finally` ran
because `.return()` was actually CALLED" apart from "the `finally` ran
because the generator completed normally and exhaustion happens to log
the same line." `s040-close-vs-completion.mjs` instruments `.return()`
itself: for `break`/`return`/`throw` the instrumented log
(`.return() CALLED (IteratorClose)`) fires before the generator's own
`finally`; for exhaustion it never fires at all, even though the
`finally` still runs. This is the exhaustion row's real evidence — not
merely "no `.return()` needed," but "measured to never happen" — and
directly supports the "exhaustion skips the close, independent of any
close" parenthetical earlier in this entry. **Pinned** (the increment 19
final unit's own citation read found this instruction unfulfilled at the
time): `wasm-statemachine.test.ts`'s "register close-out: S039/S040
forward-instruction pins" describe block, the S040 test — a full-source
program abandoning a for-of-over-generator all three ways (`break`,
`return`, an uncaught `throw`), asserting the CURRENT (`break`-only)
closing behavior directly. No corpus program can pin the gap itself, per
the previous paragraph.

## S041 — Structurally-identical record shapes share ONE own-key render order — first construction site wins, module-wide *(pre-existing, all three lanes; first registered here because generators are the first feature whose INTENT a collision can silently defeat)*

`declaredOrder` (`IrRecordShape`, `ShapeRegistry.intern`'s 4th argument,
types.ts) controls the own-key order every render surface uses —
`JSON.stringify`, `util.inspect`/`console.log`, `Object.keys`/`for...in`
(S031's declared-then-overflow split rides the same field) — but it is
explicitly EXCLUDED from `ShapeRegistry.keyOf`'s interning key ("metadata,
NOT identity," types.ts's own comment on `intern`). Two structurally
IDENTICAL shapes — same field names, same field TYPES, canonical
(sorted) order — therefore intern to the SAME shapeId no matter how many
times either is independently constructed, and a shape carries exactly
ONE `declaredOrder`: whichever construction the frontend's type-mapping
walk reaches FIRST for that exact shape. Every later structurally-equal
value — regardless of ITS OWN source declaration order — renders in the
first one's order, module-wide, for the rest of that module's lifetime.

**Measured directly (two runs each, all three lanes, plus Node as the
oracle — impl-inc19's own construction, independently reproducing the
reviewer's earlier `f4-collision.ts`/`f4-collision-rev.ts` measurement
exactly, no disagreement to reconcile):**

```ts
const alpha = { x: 10, y: 20, z: 30 };
const beta = { z: 300, y: 200, x: 100 }; // same 3 fields, opposite order
console.log(JSON.stringify(alpha), JSON.stringify(beta));
console.log(Object.keys(alpha).join(","), Object.keys(beta).join(","));
```

Node: `alpha` prints `x,y,z` (its own order), `beta` prints `z,y,x` (ITS
own order) — two independent objects, two independent insertion orders,
exactly as JS defines. This tier, all three lanes identically: `beta`
ALSO prints `x,y,z` — `alpha`'s order, borrowed, not its own. The
causality control — the same two literals with their SOURCE POSITIONS
swapped (`beta` declared first) — flips the divergence to match: now
BOTH render `z,y,x`, `beta`'s order this time, proving the mechanism is
first-seen-wins by construction site, not some property of either
literal's name or content. wasm was run via `inc19-probes/wasm-host.mjs`
(a standalone ABI host mirroring the differential harness's runWasm
contract as of commit 4509e88 — a probe tool, never a load-bearing
oracle, since it drifts silently if `abi.ts` changes); C and LLVM via
ordinary `tsinter build --backend c|llvm` binaries. All three lanes
agree with each other and diverge from Node identically, both directions.

**The IteratorResult record is the generator-relevant instance of this
general rule, not a special case of it.** `genResultRecord`'s shape
(`{done: bool, value: V}`, this increment's `declaredOrder: ["value",
"done"]` addition) collides with any OTHER record in the same module
whose fields are ALSO exactly `done: bool` and `value: <the same
canonicalized V>` — a real, if narrow, possibility: a hand-written
manual-iterator object (`2252-class-iterators.ts`'s `Range`/`EvenIter`/
`Letters` classes all return `{ value: v, done: ... }` literals) is
EXACTLY this shape whenever its `value` slot's inferred type happens to
canonicalize to the same union a real generator's channels would
produce. **`declaredOrder` on `genResultRecord`'s own `intern` call PINS
INTENT, not outcome.** It asserts "this shape should render value-first
when nothing else has already claimed the shape" — correct and
sufficient in an UNCONTESTED module (no other same-shaped construction
anywhere in it, the common case), but in a module where some OTHER
construction of the identical shape reaches the interner first, that
other construction's declared order wins for the generator's
IteratorResult too, module-wide, exactly as the measurement above shows
for two ordinary object literals. Intent and outcome are genuinely
different questions; this entry answers "what does the compiler assert
the order SHOULD be" (the genResultRecord fix) and "what does a given
module actually OBSERVE" (a first-seen-wins race this entry does not
close) as two separate things on purpose.

**`2252-class-iterators.ts` is harmless TODAY, confirmed by direct
reading, not assumed.** It has no `function*` anywhere — `genResultRecord`
never runs in that module at all, so there is no generator shape for its
`{value, done}` literals to collide with. Its own three `next()` methods
independently declare `{ value: ..., done: ... }` in the SAME (value-
first) order as each other and, as it happens, the same order this
increment's `declaredOrder` fix now asserts for generators — coincidence
of authoring style (JS programmers write `value` before `done` almost
universally), not a guarantee this entry is asserting for any future
program that combines the two shapes with either literal declared
`{done, value}` first.

**No corpus program can exercise the collision and pass, on any lane —
the S037/S038-family argument applies unchanged.** A program constructing
two structurally-identical records in opposite declared order and
observing BOTH their independent orders would print Node's TWO distinct
orderings and this tier's ONE borrowed ordering identically wrong on
every lane (the measurement above), so such a program could never have
passed the byte-exact differential and could not be in the corpus today,
generators or not. This is PRE-EXISTING debt: `declaredOrder`'s
first-seen-wins interning predates generators entirely (hybrid records,
S031, are the same mechanism) and applies to any two structurally-equal
shapes tier-wide — this increment is what makes it relevant to a NEW
family (generator results colliding with hand-written iterator-shaped
literals), which is why it is registered now rather than being a defect
newly introduced here.

**Alternatives considered and rejected (design record).** An intern-FIRST
guarantee — eagerly interning `genResultRecord`'s shape at module
initialization, ahead of any user code, so a generator's own intent
always wins the race — was rejected: it does not remove the divergence,
it only moves WHICH construction loses it (an ordinary two-literal
collision between unrelated user code would still exist, unwitnessed by
any generator), so it trades one silent module-dependent race for
another rather than closing the class. A distinguishing marker on
`IteratorResult`'s shape (so it can never structurally collide with a
hand-written iterator's return value) was also rejected: `2252`'s whole
point is that a real generator and a manual `next()` implementation are
STRUCTURALLY THE SAME THING to consumers (for-of, spreads, destructuring
all work identically over either) — a marker that fractures that
unification would be a bigger, unrelated behavior change to fix a
render-order corner, not a proportionate response.

**Tested by:** the measurement above (`inc19-probes/f4-collision.ts`/
`f4-collision-rev.ts`, the reviewer's original construction, plus
`f4-collision-impl.ts`/`f4-collision-impl-rev.ts`, this entry's own
independently-authored reproduction with different field names/values —
the two agree exactly, no disagreement to report) is Node-oracle and
all-three-lane confirmed, twice each, both directions — but per the
corpus-unpinnable argument, nothing IN THE SUITE pins the collision
itself (a passing test asserting the wrong order would be a test that
the tier is broken, not that it works). The generator-specific stage A
unit pin (wasm-statemachine.test.ts) covers the UNCONTESTED case only —
`genResultRecord`'s `declaredOrder` is exactly `["value","done"]`, and a
value-first render for a generator result IN A MODULE WITH NO COMPETING
SHAPE — deliberately not attempting to pin the race itself, which is
what this entry registers instead.

## S042 — Bare `this` in a dyn-called plain function binds only through the MODELED dispatch set *(inherited; newly observable on the wasm tier)*

The ambient-receiver bracket — the stack `dyn.this` reads (C:
`scr_dyn_this_push_dyn`/`_pop` in `scr_dyn_invoke.c:358-397`; wasm:
`dyn.ts`'s `thisPush`/`thisPop` around `invoke()`'s OBJ and
`apply`/`call` arms) — is threaded ONLY through the `dynInvoke` ladder,
and the frontend synthesizes `dynInvoke` only when a dyn method call's
NAME is in the fixed `DYN_DISPATCH_METHODS` set
(`lower-calls.ts:4450-4466`: `apply`, `call`, `push`, `forEach`, `on`,
… — inherited prototype and emitter/stream names, ~40 entries). A call
through any OTHER own-member name — `const o = { x: 42, m: function ()
{ … this.x … } }; o.m()` — lowers to a plain keyed-get + `dynCall`/
`callFn` on every lane, and the bracket is architecturally unreachable
for it: `this` inside the body reads the engine-strict `undefined`
where Node binds `o`.

Measured (2026-08-17, one probe, all three answers from the same
program — `objmethod.mjs`, a strict-mode object-literal method called
directly and through an indirection): Node prints `42`/`42`; the C
lane prints `no-this`/`no-this` (generated C shows `sc_dyn_key_get` +
`scr_dyn_call`, zero `scr_dyn_invoke` calls); the wasm lane
post-`dyn.this` prints `no-this`/`no-this` — the two tiers agree
exactly and both diverge from Node identically. The divergence is
newly OBSERVABLE on the wasm tier: before the `dyn.this` landing every
bare-`this` read refused (`libCall:dyn.this`), so nothing could
witness the unbound receiver.

**Rationale:** inherited — the C runtime brackets only the invoke
ladder, and the wasm port transcribes that boundary rather than
inventing a wider one. The real fix belongs at the LOWERING (thread
the receiver into every dyn method call, not just the modeled names) —
tracked as board #91 (filed at the increment-22 close; the "open
cross-lane bug" this sentence promised had no item until then), not
registered away: this entry
records the CURRENT shared behavior so the wasm lane is not silently
"more bound" or "less bound" than its siblings while the lowering fix
waits. Related: the suspension half of the same bracket is FENCED, not
divergent — a suspendable body (async/generator) containing a
`dyn.this` read refuses loudly at state-machine lowering
(`libCall:dyn.this:suspending`), because the wasm state machine
returns through the bracket at the first await where C's fibers do
not; a silent post-await misread is the miscompile class increment 19
documented, and the fence is the loud alternative.

**Tested by:** the wasm emitter unit test's `dyn.this` pins (the
AGREEING arms: modeled OBJ dispatch sees the receiver, `apply`/`call`
bind their `thisArg` including `null`/`undefined`, nesting and the
throw path restore, a bare call answers `undefined`) and the
suspension-fence pin (exact kind string). No corpus program can pin
the divergence itself — a program printing the unbound read would
fail Node-vs-native on every lane, which is exactly why it survived
unregistered until the wasm rider made it reachable.

## S043 — The wasm static island FENCES unmodeled surfaces at runtime, loudly, where the native island's engine is Node-exact *(wasm tier)*

The wasm tier's island has no engine (jsval ≡ dyn, increment 21), so
surfaces the native island gets from QuickJS for free are MODELED
piecewise — and every reachable, unmodeled surface throws a loud
catchable fence rather than answering silently wrong. S023 is the
stance's precedent; the difference in domain is why this is its own
entry: S023's dyn world has S015's registered leniency, while jsval's
contract is JS-exact, and the native lanes ARE Node-exact on these
surfaces — so a silent wrong answer here would be corpus-pinnable
(passes native, fails wasm only), the class this tier never ships.

The fenced surfaces, all three-lane measured (wasm fences / C = Node
exact):
- **Prototype-member reads** on island receivers: closed Node-measured
  tables of the function-valued own members of Object.prototype (10,
  annex-B definers included), Function.prototype (4), Array.prototype
  (38), String.prototype (50), Boolean.prototype (2) — reads of a
  tabled name (own property absent; own ALWAYS shadows, matching
  Node's `({toString: 5}).toString === 5`) throw
  `'<Ctor>.prototype.<name>' on an island value is not supported yet`.
  Number.prototype's six ARE modeled (typeof/name/length-correct
  per-name interned placeholder functions — `(5).toString === (6).toString`
  answers Node's `true`, different names `false`; CALLING one is stage
  B's surface and refuses at compile time today). Three non-function
  names ride the same gate: `__proto__` (all kinds — an accessor, so
  the function-shaped tables correctly cannot hold it), and
  `caller`/`arguments` on functions (throwing accessors in Node; the
  fence is one step short of Node's own TypeError, never a silent
  undefined). Names in NO table keep the honest `undefined` of a
  genuinely missing key, which IS Node-exact.
- **Non-index keyed writes on island arrays**: `a["foo"] = 7`,
  `a["1.5"] = 8`, `a[-1] = 7` throw "Cannot create property '<key>' on
  array" where Node (and the native island's real engine array) adds an
  expando — loud and catchable; UNCAUGHT, it aborts the program where
  Node runs to completion. In-range and growth writes are exact
  (`a[5] = 9` grows with holes, "1,2,3,,,9" — all three lanes agree).
- **`__proto__` as an object-LITERAL key** refuses at COMPILE time
  (`jsOp:objLit-proto-key`): JS's literal `__proto__:` is the
  prototype-setter special form (a non-object value is a silent no-op
  creating NO own property — Node and the native island both answer
  "object" for the subsequent read; storing an own entry instead would
  be a wasm-only silent divergence). The computed variant
  `{["__proto__"]: v}` already refuses at the frontend.

The stage-B roster joins the same list (increment 21 stage B, all
measured the same way):
- (INC-27 U6: the former `Math.pow` / `**` bullet is DELETED here, not narrowed: `**` computes for every operand pair and fences nothing — S079.)
- **The unmodeled-name half of the Number-placeholder call surface**:
  calling an extracted placeholder whose NAME is not modeled for real
  dispatch (`toLocaleString.call(5)`, or `toExponential.call(5, 2)` — the
  DIGITS-taking form, an IR signature this tier's key cannot express;
  INC-25 P4 §7.8) throws the honest "'Number.prototype.<name>' on a
  dynamic value is not supported yet" — while the WRONG-RECEIVER case
  keeps Node's own exact "requires that 'this' be a Number" TypeError
  (the split replaced one false message covering both situations).
  `toPrecision` and `toFixed`/`toFixed0`/`toExponential()` (the
  digit-free form) left this clause in INC-25 P4: every one of them now
  answers Node's own text through the same shared, unfenced expansion —
  see the two amendments this replaced, below.
  (INC-25 P4: the entry's own former first two bullets —
  `Number.prototype.toString(radix)` with radix != 10, and
  `Number.prototype.toFixed` beyond the `intDigits + f <= 14` window —
  are DELETED here, not narrowed: `%w.toRadix` now ports
  DoubleToRadixStringView exactly for every radix 2..36 including the
  fractional part, and toFixed/toFixed0's implementation — called by
  both the static key and the dyn NUM receiver — is exact across the
  whole 0..100 digits domain, so neither fence
  fires on any input. The 120-cell independent differential this entry
  used to cite is superseded by a >=100000-row Node-oracle sweep at the
  freeze; that number belongs to the findings, not the register.)

**Rationale:** the fence is the loudness contract applied inside a
claimed program: a construct the tier cannot yet answer Node-exactly
throws where it runs, instead of miscompiling. Every fence is
reachable only on axes no corpus program exercises (the census is
byte-stable across the fences' introduction — verified by full bucket
membership diff); a future corpus program that hits one fails the
differential loudly, which is the contract working, and the fix is to
MODEL the surface (stage B's tables), never to widen the silent set.
**Tested by:** the increment-21 unit pins — per-kind fence texts,
own-shadow precedence, placeholder identity (per-name interned),
FUNC-only scoping of caller/arguments with the negative control
(other kinds keep Node's own undefined), the literal-key refusal with
its near-miss-name negative control, and the review rigs' g1–g5 +
h1–h6b probe set (session-15 gate, four rounds).

**Amendment (unit A1): spread calls, object spread and descriptors.** The
island's spread call (`f(...s)`, jsOp callSpread — now also the lowering of
a spread call on an `any`-typed callee, which used to be a non-spread
`apply`) and object spread (`{ ...s }`) are modeled; three shapes fence by
name, measured against Node v24.18.1:
- **A nullish spread source V8 renders in a way this tier does not
  model**: the nullish spread-call TypeError names the source as V8's
  CallPrinter renders it (`f(1)` → `f(...)`, `o["x"]` → `o.x`, parentheses
  dropped). The front end renders it for every lane (board #242: the lanes
  printed the source text verbatim) for identifiers, `this` and
  parenthesized rendered expressions followed by `.name` / `[name]` / call
  chains, a numeric-literal key printed as its VALUE (`o[0x10]` reads
  `o[16]`, `o[99999999999999999999]` reads `o[100000000000000000000]`,
  `o[1_000]` reads `o[1000]`, as V8 prints them) and a string-literal key without escapes printed as
  `.content` (`o["0"]` reads `o.0`, `o["a-b"]` reads `o.a-b`, measured).
  Any other shape (`o?.x` — Node's "(intermediate value)" — `(void 0)`,
  an escaped string key, whitespace, other operators) throws a catchable
  Error instead: "spreading null or undefined from this expression into a
  call is not supported yet" on the checked-dynamic call path (a dynamic
  source), "spreading null or undefined from this expression into an
  island call is not supported yet" on the island's callSpread. A
  non-nullish source of any shape is exact.
- **Spreading an error value** — ANY object carrying the reserved `%error`
  key, a caught error held in an `any` or user data spelling the key
  (`{ ...JSON.parse('{"%error":1,"k":2}') }`) — into an island literal
  throws the catchable "spreading an error value (an object carrying the
  reserved %error member) into an island object literal is not supported
  yet", where Node copies its enumerable members (none for an Error, both
  keys for the user object): the encoding's members would copy, marker
  included, and make the copy an error (S021; S025 is the user-data side
  of the same key). `Object.assign` keeps S021's registered answer.
- **`Object.defineProperties` with a function as a descriptor**, or a
  descriptor the front end could not hold as a dynamic value (an accessor
  `{ get() {...} }`, a record with function fields), throws a named Error
  at the call, where Node reads the descriptor (for the accessor, defines
  the getter). It used to define `undefined` silently.

**Tested by:** A1-SPREAD-03/05, A1-OSPREAD-03 and A1-DEFPROPS-01 in
`packages/compiler/test/wasm-island-a.test.ts`.

**Amendment (unit A2): island getters and `Object.create`.** An island
literal's `get k() {...}` member is now modeled (read through the getter —
a getter body using `this` still refuses at compile time, so the receiver
binding is not observable; `[Getter]` to `util.inspect`; JSON,
`Object.values`/`entries`, object spread and `structuredClone` read its
answer), and the
island's `Object.create(proto)` builds a null-prototype object or an object
LINKED to `proto` (reads, method calls and `in` delegate live; own-key
surfaces stay own). The surfaces this does not model fence by name, each
measured against Node v24.18.1:
- **A write over a getter-only member**, own or inherited (`o.g = 5`): a
  catchable "assigning to the getter-only property 'g' of an island object
  is not supported yet" Error, where Node's strict code throws
  `TypeError: Cannot set property g of #<Object> which has only a getter`
  and its sloppy code ignores the write (the writing code's strictness is
  not known at the write). `Object.assign` onto such a member is the same
  fence ("copying onto the getter-only property ...").
- **A getter read by a reader that cannot run it** — a typed conversion of
  the object (`f(o)` into a record parameter), an option record, the error
  encoding's members, deep equality — reports the uncaught "reading a
  getter-defined property of an island object here ... is not supported
  yet" rather than reading a stale value; Node runs the getter. (A reader
  not taught about the cell at all traps.)
- **A getter written BEFORE a data member of its literal** (`{ get g()
  {...}, n: 2 }`) refuses at compile time (`jsOp:defineGetter-order`): the
  front end defines getters after the data members, which would enumerate
  `n` before `g` where Node keeps source order.
- **`Object.create` over an array, a function, bytes, a promise, a handle,
  a null-prototype object or a built-in stand-in** throws a catchable named
  Error where Node creates the object; a primitive prototype throws Node's
  own `TypeError: Object prototype may only be an Object or null: <v>`.
  The properties argument (`Object.create(p, props)`) refuses at compile
  time.
- **Deep equality over a linked object** reports an uncaught named refusal
  (Node compares the prototypes).

**Tested by:** A2-REF-01..05 in `packages/compiler/test/wasm-island-a.test.ts`,
each with Node's answer beside it.

**Amendment (unit A3, board #243): method calls through a member key or a
spread.** `o["m"](...)` with a literal key on an island or checked-dynamic
receiver is now the method call it is in JS (`this` = `o`; it called the
member with `this` undefined), and `o.m(...pre, ...s)` / `o["m"](...)` with
one trailing spread runs the island's spread call with `this` bound (it was
fenced). The island's "<x> is not a function" text now spells the callee
as V8 does (`o.zz`, `o.v` for `o["v"]`, `o[16]` for `o[0x10]`,
`o.list[0]` for `o["list"][0]`), where the wasm tier named only the
method; a callee V8's rendering does not cover keeps the method name.
Three shapes still differ:
- **A computed key** (`o[k](...)`, `fns[i](3)`, `table[k](1)`) keeps the
  plain call it always lowered to, on every lane and every receiver: the
  member is read, then called with `this` undefined, where Node calls it
  with `this` = `o`. Arrows and functions that never read `this` (the
  dispatch tables programs write: corpus 2600's
  `catchWarning[warning.name](warning)`) answer exactly as Node; a plain
  `function` member that reads `this` sees undefined (A3-MCALL-09: Node
  prints 7, this tier `undefined`). On a checked-dynamic receiver spread
  arguments on a literal-key call keep the stored-member path `o.m(...xs)`
  takes as well.
- **The spread method form reads the member AFTER the arguments**: Node
  reads `o.m` first, then evaluates the arguments and the spread. The two
  orders differ only when reading the member has an effect the arguments
  observe (a getter, a proxy) or an argument replaces the member.
- **On the c and llvm lanes `this` never binds for a function stored on
  an island object**: `o.m(1)`, `o["m"](1)` and both spread forms call
  the member with `this` undefined (a member reading `this.v` with `v` = 7
  prints `undef:1` where Node prints `7:1`). This predates the unit for
  `o.m(1)`; the wasm tier binds `this` in all four.
The dot form `o.m(x)` on a checked-dynamic receiver keeps S042's answer.
`o.toString()` on an island object (plain or linked) now answers like
`String(o)` — Object.prototype.toString through the method call, where it
threw "is not a function" — and an own or inherited `toString` member is
still the one called.
**Tested by:** A3-MCALL-01..09, A3-TOSTR-01 and A3-RENDER-01/02 in
`packages/compiler/test/wasm-island-a.test.ts`.

**Amendment (unit F1): an island RegExp value.** A RegExp crossing into
`any` (the boundary's `new RegExp(re.source, re.flags)` over a regex
literal or a const binding holding one) is now a value on the wasm
island: the static tier's compiled regex inside an empty island object
(`$dynObjRegex`), so `typeof`, `Object.keys`, `JSON.stringify` (`{}`) and
spread answer as Node's do. Modeled: `source`, `flags`, the flag
accessors (`global` … `unicodeSets`), `lastIndex` (reads 0; an own
member for `in`/`hasOwn`), `test` on a non-global, non-sticky regex
(one match from index 0), `toString`/`String(r)`/template conversion and
`util.inspect` (`/src/flags`), and deep equality (source and flags).
Fenced by name where Node answers: `test` on a `g`/`y` regex (it reads
and moves `lastIndex`); `exec` and `compile`; a RegExp.prototype
function read as a value (`typeof r.exec` throws where Node answers
"function"); ANY member write onto the value (a member assignment,
`lastIndex` and the accessor names included, and the Object.assign /
Object.defineProperties targets), so an island RegExp never holds an own
member and its readers (the method calls, `inspect`, the accessors)
stay exact; `Object.create` over one (the built-in stand-in refusal —
Node's accessors would throw on the non-RegExp result); and
`structuredClone` of the value. The
emitter's own `new RegExp(...)` arm refuses a pattern not known at
compile time (`regexp-dynamic-pattern`) — since unit P1 only when the
pattern or flags is not statically a string: a string known only at run
time (a run-time regex value's own `.source` / `.flags`) compiles at run
time as S065's run-time arm and S102 say —, a pattern Node's `.source`
would escape (`regexp-source-escape`: an unescaped `/`, a line
terminator, the empty pattern) and an invalid flag string
(`regexp-invalid-flags`); the front end already refuses a regex value
whose pattern is computed at run time before it reaches the boundary.
**Tested by:** F1-RE-01..05 and F1-CORPUS-2172 in
`packages/compiler/test/wasm-island-a.test.ts`.

**Amendment (unit I): unions, URLs and typed arrays crossing into a
dynamic value.** A union crosses by its runtime tag (each arm's own
conversion; an `undefined`/`null` arm is the island's own unit), Node's
answer. A WHATWG URL crosses BY REFERENCE as an empty island object
carrying the URL (`$dynObjUrl`): `href`, `protocol`, `host`, `hostname`,
`pathname` and `search` read Node's values, `String(u)`, template
conversion, `toString()`, `toJSON()` and `JSON.stringify` answer the
href, and keys/spread see no own members (Node's own answer). Fenced by
name where Node answers: `hash`, `port`, `origin`, `username`,
`password`, `searchParams`, `constructor` (an inherited member, which
S015's stance would otherwise answer undefined where Node gives URL),
and `toString`/`toJSON` read as values; a URL reaching a string slot
(`new URL(u)`, where Node reads its href, or a `string` parameter, where
Node holds the object: "passing a URL held in a dynamic value where a
string is expected is not supported yet", for jsExit and a typed
promise adoption alike);
`structuredClone` of one (Node throws a DataCloneError there; this text
differs); any member write onto one (`u.href = …`, where Node's setter
reparses, or a new member) and `Object.create` over one (Node: "Receiver
must be an instance of class URL" at the first getter), so a URL never
holds an own member its getters would shadow; deep equality over a URL
refuses uncaught. A Uint32Array, Int32Array or
Float32Array crosses BY REFERENCE (S014's bytes rule) as a JSVAL-tagged
`$dynTyped` value, so a reader never taught the kind TRAPS rather than
answer `{}`, `[]` or `undefined`. Answered (Node's values): `length`,
canonical index reads (out of range `undefined`), `BYTES_PER_ELEMENT`,
`byteLength`, `typeof` ("object"), truthiness, `===` (the same bytes),
`"k" in u` (an index by range, a TypedArray.prototype name true, any
other name false — S015 keeps Object.prototype's names false), and
`constructor` — an interned function box with Node's `name`, `length`
and `BYTES_PER_ELEMENT`, equal to itself across reads; every other
static member read off the box (`from`, `of`, `prototype`, `isBuffer`, …)
refuses by name. A Uint8Array's or Buffer's `constructor` read off a
dynamic value now answers the same way; a Buffer's reads as Uint8Array's
(`name` "Uint8Array", the same box), S037's rendering of a Buffer that
crossed into a dynamic value.
Refused by name, catchable, where Node answers: JSON.stringify, method
calls and TypedArray.prototype functions read as values, member writes,
spread, Object.assign from one, key walks, `Object.hasOwn`, iteration
and inspect; refused by name UNCAUGHT (the sites cannot throw
catchably): `String(u)`, template conversion, arithmetic and deep
equality. Calling or constructing through a `constructor` read this
way refuses by name ("calling the Uint32Array constructor read from a
dynamic value is not supported yet"; Node: "Constructor Uint32Array
requires 'new'", or a new array), as does `a.constructor(…)` called as a
method on any of the four kinds, catchably ("calling 'constructor' on a
typed array held in a dynamic value is not supported yet"). Readers not audited for the kind
(`structuredClone`, for one) trap.
**Tested by:** I-UNION-01, I-URL-01..04, I-TYPED-01..04, I-CTOR-01 and
I-CORPUS-766 in `packages/compiler/test/wasm-island-a.test.ts`; R90n,
R91n and R94 in `wasm-dynsmalls-u5.test.ts`.

**Amendment (unit P): `Array.prototype.flat` and `Promise.all` on the
island.** `flat` leaves the fenced list: it is modeled on island arrays
(the depth argument through ToIntegerOrInfinity for a primitive —
absent or `undefined` is 1, `"2"` is 2, `true` is 1, `null`, NaN and
negatives flatten nothing, `Infinity` all the way; only arrays flatten,
a fresh array always; a cyclic array under `flat(Infinity)` throws V8's
catchable `RangeError: Maximum call stack size exceeded`). Three
differences remain, measured against Node v24.18.1:
- **An object depth refuses by name.** A depth that is an object,
  array or function would need ToPrimitive (`valueOf`/`toString`),
  which this tier's ToNumber does not run: it throws the catchable
  `TypeError: <callee>.flat: non-primitive depth arguments on a dynamic
  receiver are not supported yet` (the index-argument fence's shape),
  where Node flattens by the converted depth (`{ valueOf() { return 2 }
  }` is 2, `{}` is NaN, so 0).
- **A fixed nesting cap.** Past 1000 nested levels `flat` throws that
  RangeError — the depth S013's JSON parser stops at —
  where Node, whose limit is its stack (about 8900
  levels at the top of a fresh process, fewer deeper in a call chain),
  still flattens. Arrays nested 1000 deep or less answer exactly, from
  a call chain 3000 frames deep (measured); the cap
  keeps the recursion inside the wasm stack, which would otherwise
  overflow into an uncatchable host error.
- **Padded slots are present.** A slot S016's growth write padded
  (`a[3] = x` on a shorter array) reads as `undefined` and `flat` keeps
  it, where Node's hole is skipped (`g = [[0]]; g[3] = [9]; g.flat()` is
  `[0, 9]` there, `[0, undefined, undefined, 9]` here) — S016's
  enumeration divergence, reached through one more walker.
Island `Promise.all(x)` is modeled over the island's spread iteration
(arrays element-wise, strings by code point): each element through
PromiseResolve, Node's turn count, input order, the first rejection
winning and the losers not reported. A non-iterable gives a REJECTED
promise with V8's own text ("number 5 is not iterable (cannot read
property Symbol(Symbol.iterator))"), never a synchronous throw. An
element that is a thenable object (an object with a callable `then`
that is not a promise) meets settle's named refusal ("resolving a
promise with a non-promise thenable is not supported yet"), uncaught,
where Node calls its `then`. `Promise.race`, `allSettled` and `any` on
an island argument keep refusing at compile time (`expr:jsOp`).
**Tested by:** P-ALL-01..04, P-THEN-01 and P-FLAT-01..05 in
`packages/compiler/test/wasm-island-a.test.ts`.

## S044 — jsExit of `array<jsval>`: the SPINE aliases on the wasm tier (matching Node); the native island copies it *(per-lane split)*

The validated exit of an `any[]`-declared slot crosses elements BY
REFERENCE on every lane. The SPINE differs: the C island snapshots it
at the exit (scr_island.c: "element IDENTITY crosses, THE SPINE IS A
COPY"), so a post-exit write or push through the exited value is
invisible through the original (`p[0] = 99` reads back "1"; `p.push(4)`
leaves the original length 3). The wasm static island hands the dyn
ARR payload's vector over whole — spine aliased — and matches Node on
both probes ("99"; length 4). The wasm lane is the MORE Node-exact
side; the split follows the S014 bytes-amendment framing (the
transitional native lanes keep their structurally-forced copy; the
wasm representation has nothing to copy). **Tested by:** the
increment-21 unit pins covering both directions (write-through and
push-through), with the C lane's divergent values pinned beside the
wasm/Node values so the split is explicit and cannot be silently
"aligned" in either direction.

**Amendment (unit P): `any[]` crossings alias on the paths S014's
unit-P amendment lists, and the `Promise<any[]>` bridge settles the same
way.** An island value reaching a `Promise<any[]>` slot (an inferred or
declared `Promise<any[]>` return over `Promise.all(...)` or an island
promise — corpus 2633's `loadAll`) goes through PromiseResolve. A static
`Promise<any[]>` that crossed into the island (island `Promise.all`'s
result, a jsMarshal'd promise, a bridged promise that crossed back)
comes back as ITSELF. Any other source is bridged into a static promise
that settles the moment the source does (at once when it already has),
with waiters on it parked on the source itself, so both sides' waiters
run in one attach order with no turn added — Node's queue order,
measured with competing microtask chains, `queueMicrotask`, timers,
already settled and pending sources, and waiters attached on both sides
in both orders. Attaching to a bridged promise marks its source handled
(V8 marks a promise handled at attach), and a bridged promise rejected
with its source's reason is never reported itself, so the unhandled
report is the source's alone, as in Node where the two are one promise.
Resolving a source with its own bridged promise (through any chain of
bridges) is Node's `TypeError: Chaining cycle detected for promise
#<Promise>`. An async function's `return x` into `Promise<any[]>` adopts
a promise held in `x` (Node's two jobs), as board #234 does for the
other typed returns. A fulfilment that is an island array hands over its
vector by reference; a rejection crosses unchanged. Differences from
Node, where no boundary exists:
- **Two bridges of one island source are two promises.** `viaBox() ===
  viaBox()` over one island promise is `false` here, `true` in Node (a
  bridged promise is a distinct static promise whose payload is the
  vector); a crossed static promise and a bridge of a bridge DO answer
  themselves (`true`, as in Node).
- **A non-array fulfilment rejects.** The static promise (or the async
  function's own promise) rejects with the jsExit array arm's own
  catchable `TypeError: expected an array, got <typeof>` (S009's
  footing: scriptc's boundary text, no Node oracle), where Node's
  awaiter receives the value as it is (`ok object`, `ok number`). That
  rejection is the bridge's own, so a promise derived from it that
  nothing handles (`p.then(cb)` with no catch) is reported as an
  unhandled rejection and the program exits 1, where Node runs on.
- **A non-array argument fails at the parameter.** An island value
  that is neither an array nor `undefined` reaching an `any[] |
  undefined` parameter throws the checked exit's `TypeError: expected
  array | undefined at $, got number` at the call, where Node binds it
  and fails later at its first use (`xs.push is not a function`).
**Tested by:** P-BRIDGE-01..13, P-ASYNC-01..03, P-CYCLE-01, P-UNH-01,
P-IDENT-01, P-PARAM-01, P-HELD-01, P-LIFT-01/02 and P-CORPUS-2633 in
`packages/compiler/test/wasm-island-a.test.ts`.

**Amendment (unit H): for `any[]` slots this entry no longer applies —
on any lane.** An `any[]` is the island array itself (S014's unit-H
amendment), so a value reaching an `any[]` parameter, local or field
crosses no exit and neither copies its spine (the native split this
entry registered) nor needs the wasm hand-over: the C and LLVM lanes now
print Node's `99` / length 4 on the write-through and push-through probes
(the increment-21 pins, updated). Three of the unit-P differences listed
above are retired with it: a non-array `Promise<any[]>` fulfilment
arrives as it is (Node's `ok object` / `ok number`, no rejection, no
unhandled report — P-BRIDGE-01/13, P-ASYNC-03), two reads of one island
promise through a `Promise<any[]>` function are one promise (`true` —
P-IDENT-01), and a non-array reaching an `any[] | undefined` parameter
binds as it is and fails at its first use, with the engine's own text
(`xs.push is not a function` on wasm; quickjs-ng's `not a function` on
the native lanes — P-PARAM-01). A read the checker types as a primitive
over such a value still exits validated (S110 (d)). The bridge machinery
remains for promises of static payloads; the jsExit array<jsval> arm
remains for the static arrays of handles the runtime still builds
internally (a static `Promise.all` result), whose spines are fresh.

## S045 — A dynamic-import namespace member with no compiled crossing is a TRAP FUNCTION, not the value *(inherited; newly reachable on the wasm tier)*

The own-module dynamic-import namespace is a frontend-synthesized object
builder (lower-island.ts's dynNsBuilderOf): each VALUE export marshals
into the island if it can, and an export with NO island representation —
a class, a generic function, an un-marshalable record shape — becomes a
TRAP FUNCTION: a real function whose any USE throws the pointed
compile-informed TypeError ("the '<name>' export is a value of type …
cannot cross into dynamically-executed code yet"). The namespace still
builds; only the use has no compiled story. Consequences, measured
three-lane (increment 21 stage C review): for such an export,
`typeof ns.member` answers "function" on BOTH compiled lanes where Node
answers the value's own typeof (e.g. "object" for an exported record
carrying a closure field), and CALLING it throws the compiler's teaching
text where Node would throw its own ("t is not a function") or succeed
outright.

**Rationale:** inherited — the substitution is the frontend's design
(both native lanes have shipped it since the island landed; the wasm
tier joining the bridge in increment 21 is what made it REACHABLE there,
which is why it is registered now, per the register-before-merge rule).
The alternative — refusing the whole import when any export is
un-marshalable — would break the dominant pattern (a module with one
hard export and many easy ones, imported for the easy ones). Both
compiled lanes agree and Node differs, so no corpus program can pin the
divergence (a program observing it fails native-vs-Node by construction
— the S015-family argument, valid here because the LANES AGREE). The
loudness contract holds at the USE: touching the substituted member
throws with the export's name and type spelled out, never a silent
wrong value.

**Tested by:** the frontend's own island tests exercise the trap-fn
construction; the wasm lane's reachable half is covered by the eleven
TLA/import claims (whose exports all marshal — no trap fn fires in a
CLAIMED program's output, which the census's byte-exactness enforces
structurally). The typeof divergence itself is corpus-unpinnable per
the rationale; the increment-21 stage C review probes are the
measurement of record.

## S046 — `read(n)` size coercion parses the NUMBER, not Node's STRING: sub-microscopic fractional sizes diverge *(all three lanes)*

Node coerces a non-integer `read()` size with `parseInt(n, 10)` — which
stringifies FIRST, so a nonzero fractional below 1e-6 goes exponential
("1e-7") and parses to its leading MANTISSA digit: `read(1e-7)` is
`read(1)` in Node. This tier coerces numerically (truncate toward zero;
±Infinity → absent), so the same call is `read(0)` → null. Both
compiled implementations agree (the wasm readCore and
scr_stream_read_n, the latter shared by the C and LLVM lanes — two
implementation sites, three observable lanes, all measured); Node
differs.

The OBSERVABLE set is narrower than a bare "|n| < 1e-6" reads
(measured, 4-byte buffer): a finite non-integer with nonzero
|n| < 1e-6 diverges ONLY when the exponential form's leading mantissa
digit is ≤ the buffered byte count (or the stream has ended) —
`read(1e-7)` on 4 buffered bytes reads "a" in Node and nothing here;
`read(5e-7)` on the same buffer agrees BY ACCIDENT (parseInt gives 5,
which exceeds the 4 buffered on an unended stream, so both answer
null). `read(0.000001)` itself agrees (plain stringification, parseInt
0). The NEGATIVE arm agrees in output but by DIFFERENT ROUTES: this
tier truncates -1e-7 to -0 and takes the n === 0 path; Node parses to
-1 and takes the n !== 0 path — the two differ in whether
emittedReadable is cleared, a mechanism split this entry deliberately
does NOT assert equivalent (no probe has surfaced it; a future
'readable'-flag shape could).

**Rationale:** implementing parseInt's stringify-then-parse for
numbers only reachable through sub-microscopic fractional read sizes
would mean porting number-to-exponential-string formatting into the
read path for a corner no real program occupies; the numeric
truncation is exact everywhere else — the full AGREEING coercion
matrix (negative, zero, fractional, near-integer-fractional,
±Infinity, NaN, variable, and absent sizes) is pinned in the CORPUS
by 1686-stream-readable-paused.ts's coercion-matrix section, run
differentially against Node on every lane, which is the regression
net the size-coercion fixes otherwise lacked (the census could not
see them: nothing else in tier reaches the coercion clause beyond
read(3) and read(0)). Corpus-unpinnable in the S015-family sense for
the corner alone: the lanes agree, so a program observing the
divergence fails native-vs-Node by construction. Loudness: the
divergence returns null (reads nothing) rather than fabricating data
— the conservative direction.

**Tested by:** 1686-stream-readable-paused.ts's coercion-matrix
section (the agreeing matrix, corpus-differential on every lane —
added at this entry's registration precisely so the coercion clause
has a permanent net). The DIVERGENT corner itself is corpus-unpinnable
per the rationale; its boundary measurement of record (the
leading-mantissa-digit condition, the agrees-by-accident cases, the
negative arm's route split) was established by the increment-22
stage-B review and is restated in full in this entry's own body — the
entry, not a probe path, is the durable record. The in-code comments
at both implementations' coercion sites cite this entry.

## S047 — Encoded-stream `push()` backpressure return counts utf8 BYTES, not Node's UTF-16 code units *(wasm tier; native columns unmeasured)*

With `setEncoding('utf8')` (or the `encoding` construction option)
active, this tier's Readable re-encodes decoded text back to utf8
bytes for its single bytes-only chunk list (RS_DEC_PENDING's header),
so RS_LENGTH — the value behind `push()`'s highWaterMark-gated boolean
return — counts utf8 BYTES. Node stores decoded STRINGS in string
mode and counts UTF-16 code units for this same comparison. Measured
(increment-22 stage-B gate, fix round): `push()`'s boolean
backpressure return (`new Readable({read(){}, highWaterMark:4,
encoding:"utf8"})` then `push("ééé")` answers false here, true in
Node). No claimed corpus program reads this observable — 1745/2627/
2629/1744 all push on encoded streams but every call site discards
the return.

STAGE C PASS 2 CORRECTION: this entry ORIGINALLY also covered
`readableLength` (6 vs Node's 3 for "ééé"; 5 vs 2 for "é世") — that
half is RETIRED, not still divergent. 1744 (this pass's own claim)
reads `readableLength` directly on an encoded stream (`"wörld"`:
Node's 11 string units vs this tier's then-12 utf8-byte count) —
exactly the corpus payoff this entry's own Rationale said didn't
exist yet when it was written, so it got built: a new NON-destructive
per-chunk decode-and-sum walk (`stringUnitsLengthOf`, stream.ts's
`lengthOf`) answers `readableLength` in true string units without
changing RS_LENGTH's own byte-counted representation (still exactly
what this entry's Rationale describes below — the internal
accounting stayed unbuilt on purpose, only the GETTER computes the
Node-true answer on demand). The `push()` return above shares that
SAME internal RS_LENGTH/highWaterMark comparison and is UNTOUCHED —
it still answers bytes-not-units, exactly as originally registered.

**Rationale:** matching Node's INTERNAL accounting (not just the
`readableLength` getter) would require a second, string-typed chunk
representation carrying per-chunk code-unit lengths beside the
bytes-only list every other consumer of the pass-1 machinery uses —
real representation work `push()`'s own return still has no corpus
payoff for today. The divergent direction is conservative: byte
counts are ≥ code-unit counts for non-ASCII, so `push()` reports "stop
pushing" SOONER than Node, never fabricating capacity. The native
lanes were NOT measured on this observable during the gate (no corpus
program reaches it on any lane); this entry deliberately claims the
wasm tier only — a future claim reading it must measure the native
columns before citing this entry cross-lane (the S015-family reuse
rule).

**Tested by:** corpus-unpinnable today for `push()`'s own return
(nothing in tier reads it); the measurement of record is the
increment-22 stage-B gate's probe pair (hwm-4 push-return + the
"ééé"/"é世" readableLength case, the latter now historical since
`readableLength` itself closed), restated in full above — the entry
is the durable record. `readableLength` itself IS now pinned: 1744's
own "wörld" case (11 units), corpus-verified. The RS_DEC_PENDING
header cites this entry.

## S048 — for-await early exit (`break`) originally left the Readable ALIVE where Node's async iterator destroys it — RESOLVED by the stage D P4 build *(wasm tier; historical body below, current behavior in the P4 amendment)*

Node's `Readable[Symbol.asyncIterator]` destroys the source stream
when the loop exits early (break, return, or throw); the lowering
compiles for-await over a Readable as an awaited
`readable.nextChunkDyn` per iteration, so a `break` simply exits the
compiled loop — no iterator-`return()` hook exists and no
break-driven destroy ever fires. The observables SPLIT BY SHAPE
(both measured, mini-gate MG-1). Shape A — the stream NOT yet ended
at the break: this tier's stream stays fully ALIVE (`destroyed`
false, no 'close', `push()` still answers true) where Node destroys
it (`destroyed` true, 'close' fired, `push()` false); `readableEnded`
is false on BOTH sides in this shape — not a divergence. Shape B —
the stream already `push(null)`'d before the break: this tier's
stream ends NATURALLY one turn later and auto-destroys by its own
route, so `destroyed` and 'close' CONVERGE with Node and the durable
divergence inverts to `readableEnded` (true here — the end actually
ran; false in Node — destruction preempted it). The SHARPEST
observable (measured in shape B): a SECOND for-await over the same
stream after the break completes normally here (exit 0) where Node
throws ERR_STREAM_PREMATURE_CLOSE uncaught (exit 1) — silent-continue
vs crash. No claimed corpus program exits a for-await early (1746
always drains to completion).

**Rationale:** the fix is a lowering-level change (emit a destroy
call on every abnormal exit edge of the compiled loop — frontend
territory this backend-only pass deliberately did not touch);
registered now rather than shipped silent, with the build tracked as
a board item for a later streams stage. Divergence direction: in
shape A the stream is left alive and intact, and in shape B it
merely finishes by the route Node's destruction would have preempted
— nothing is ever fabricated and no data is lost, but the
re-iteration observable means this tier SUPPRESSES a crash Node
would raise, which is why that observable leads this entry's list
rather than the property reads.

**Tested by (HISTORICAL — superseded by the P4 amendment below):**
while the divergence stood it was corpus-unpinnable (a pinning program
would have failed against Node by construction); the measurements of
record were the increment-22 stage-B gate's g-break probe and the
mini-gate's shape decomposition (mg-break-alive, mg-break-observables,
mg-break-then-iterate). Since the P4 build, the durable instruments are
`wasm-stream-forawait.test.ts` (16 tests, two of them S049 regression
guards — S048's own durable pins are the other 14) and the six-cell
table in the amendment below.

**STAGE D P4 AMENDMENT (rider #72 BUILT — this entry's own deferred
build landed):** the wasm-tier divergence above is RESOLVED. The
lowering (`lowerForAwaitReadable`, frontend territory as this entry's
own Rationale anticipated) now wraps the compiled loop in a
try/finally keyed off a `normalCompletion` flag — the standard for-of/
for-await IteratorClose desugar, using the IR `"for"` node (not
`"while"`) specifically because its continue-runs-update-first
semantics is what keeps a user `continue` from tripping the destroy
(measured directly against Node: it never does). Every abrupt exit of
the loop BODY — `break`, a cross-function `return`, and an uncaught
`throw` — now destroys the stream, and does so SYNCHRONOUSLY (zero
turns elapsed), matching Node exactly. Re-measuring the shape
decomposition above against current Node (v24.18.1) directly, before
building, found it needed two corrections, both stated plainly here
per the register's own discipline (the original text was wrong, not
merely superseded):

1. **Shape A and shape B no longer diverge in kind.** The original
   split described two DIFFERENT convergence timings for `destroyed`/
   `close` (shape A: never converges pre-fix; shape B: converges "one
   turn later" via the stream's own natural-end machinery). Fresh
   measurement found this description was itself incomplete even for
   the PRE-fix tier: shape B's "converges one turn later" claim held
   only for the fully-synchronous-merge sub-shape (every `push()` call,
   including the trailing `push(null)`, landing before the for-await
   loop's first read) — an async-delivered variant of shape B (the
   final real chunk and `push(null)` arriving together, but on a LATER
   turn than the loop's first read) stayed alive forever pre-fix,
   never converging at all. Moot now regardless: post-fix, both shapes
   destroy identically and synchronously, matching Node's own uniform
   synchronous-destroy behavior in every variant measured (one push,
   two pushes, `Readable.from`, with/without an intervening delay,
   already-ended-before-break) — the shape split itself no longer has
   observable consequence on the DESTROY timing (it still matters for
   whether more real data existed, which is not itself divergent).
2. **The re-iteration crash's identity was mis-registered.** The
   original text cited Node's crash as `ERR_STREAM_PREMATURE_CLOSE`.
   Fresh, repeated measurement (six independent shape variants, all
   unanimous) found this WRONG for the observable this entry actually
   describes: re-iterating a stream a PRIOR loop's own `break` already
   destroyed throws `AbortError` (`.name`), code `ABORT_ERR` (`.code`),
   message "The operation was aborted". `ERR_STREAM_PREMATURE_CLOSE` is
   real Node behavior too, just for a DIFFERENT, adjacent trigger this
   entry does not describe: an EXTERNAL `destroy()` (no error) while a
   for-await loop is actively parked awaiting a chunk, or before any
   loop has started consuming at all — Node's `eos` utility synthesizing
   its own premature-close error for whichever loop is watching at that
   moment. Measured directly (`stream.errored`, and whether an attached
   'error' listener fires): Node's real async-iterator break-destroy
   SUBSTITUTES a synthesized AbortError as the stream's OWN error
   (`stream.errored` reads it immediately after break; an attached
   'error' listener fires with it; but nothing crashes the process when
   NOTHING is watching, unlike an ordinary `destroy(err)` with no
   listener, which DOES crash on the next tick — Node's own async
   generator registers a persistent internal `eos()` listener that
   always counts as "handled", a mechanism this tier does not model but
   whose one externally-observable consequence it now reproduces
   directly). Once this substitution is understood, ALL of a/a2/b/b2/c/d
   fall out of a SINGLE model: the synthetic for-await-abort destroy
   (a new libCall, `stream.destroyAborted`, emitted ONLY from this
   lowering's own finally block — never from a user-written bare
   `.destroy()`, which keeps using plain `stream.destroy`) builds the
   AbortError and stores it as the stream's real error BEFORE any fresh
   waiter ever parks, so a LATER for-await's own `nextChunkDynCore` hits
   the EXISTING RS_ERROR-is-set branch in `checkWaiterCore` and
   rethrows it unchanged — no branching on THAT half at all. The
   SEPARATE "nothing left to give, no error" branch (RS_DESTROYED with
   RS_ERROR still null — an externally, plainly destroyed stream) now
   rejects `ERR_STREAM_PREMATURE_CLOSE` (settleConsumerCore's own
   literal, reused verbatim) instead of the ORIGINAL fulfilled-EOF
   silent-continue. `destroy(err)` (an explicit user error) is
   untouched by any of this — the RS_ERROR-is-set branch was already
   correct (Node rethrows the given error verbatim; 1746's own
   "mid-iter" pin already covers it). One new field WAS needed after
   all, narrowly scoped: `RS_ERROR_ABORT_SILENT`, a single-use flag
   `destroyAbortedCore` arms and `opError` reads-then-clears, existing
   ONLY to suppress the unhandled-error-crash fallback for this one
   synthesized error (matching Node's own internal-listener-always-
   handled behavior) — it carries no "how was this destroyed" meaning
   beyond that one crash/no-crash decision, and every OTHER consequence
   of the substitution (the stored error itself, 'error' listener
   dispatch, promise rejection) rides the EXISTING RS_ERROR machinery
   unchanged.

**The full cell table (all six re-measured against Node AND the built
tree, byte-exact on every one FOR THE SHAPE ACTUALLY VARIED;
wasm-stream-forawait.test.ts names the covering pin per row — gate
finding R1 narrowed cells a/a2 below, they were measured on an EMPTY
stream only, not a general "plain destroy()" claim):**

| cell | shape | Node throws | settles via |
|---|---|---|---|
| a  | EMPTY stream (nothing ever pushed), plain `.destroy()`, never iterated, then fresh `for await` | `Error` / `ERR_STREAM_PREMATURE_CLOSE` / "Premature close" | `checkWaiterCore`'s destroyed-clean branch, called SYNCHRONOUSLY from the fresh loop's own `nextChunkDynCore` |
| a2 | EMPTY stream, plain `.destroy()` while a loop is ALREADY PARKED | same as a | the SAME branch, but reached via `opClose`'s own trailing `checkWaiterCore` call — `destroy(null)` never schedules `OP_ERROR` at all |
| b  | `.destroy(err)`, never iterated | the GIVEN `err`, verbatim (`.name`/`.code` whatever the caller set) | the pre-existing RS_ERROR-is-set branch, unaffected by this rider |
| b2 | `.destroy(err)` while parked | same as b | same branch, reached via `opError` (a non-null error DOES schedule `OP_ERROR`) — 1746's own "mid-iter" pin already covers this shape |
| c  | re-iterate after a prior loop's own `break` | `AbortError` / `ABORT_ERR` / "The operation was aborted" | the SAME RS_ERROR-is-set branch as b — `destroyAbortedCore` stored the AbortError BEFORE this fresh waiter ever parked |
| d  | a THIRD attempt after the second already threw | identical AbortError, again | same branch, idempotent — no attempt-counting |

The buffered-data axis (one chunk pushed BEFORE the `.destroy()` in
cells a/a2) was never varied by this rider and is NOT covered by the
table above: gate finding R1 measured it and found a separate,
PRE-EXISTING, UNREGISTERED divergence — Node's `destroy()` DISCARDS a
buffered chunk before a consumer ever reads it, while this tier still
delivers it to a subsequent `for await`. Reproduces identically on the
unmodified base (not introduced by this rider). Filed as board #88;
not fixed here.

**New, narrow tier-shape change from this build:** a LABELED `break`
out of a for-await loop to a statement OUTSIDE it now refuses
`SC1090` ("'break' crossing a 'finally' block is not supported yet")
— the SAME pre-existing fence every other try/finally construct in
this tier already has (verified directly: a plain user-written
`try {} finally {}` with a labeled break crossing it already refused
before this build, unrelated to rider #72), now reachable through the
synthetic try/finally this lowering introduces. Gate finding R3
sharpened what "previously COMPILED" gives up: on the base tier the
divergence this entry registers was present in the stream's STATE
(not destroyed) but UNOBSERVED by a program that never checks
`destroyed`/`readableEnded` or re-iterates — measured directly (a
labeled-break probe matched Node BYTE-FOR-BYTE on its own printed
observables, on base). So the boundary this build adds does not only
trade away programs that would have SHOWN the divergence; it also
refuses programs that were Node-correct on everything they actually
observed. Refusing over a possible miscompile is still the rule-1-
correct direction (and the divergence stays registered either way) —
this is an accuracy correction to the entry's own text, not a change
in verdict. Zero corpus impact verified directly (no corpus program
combines for-await with any labeled break or continue). Plain
unlabeled `break`/`continue` are unaffected (their
target is the loop itself, contained within the synthetic try, never a
crossing); `return` is unaffected too (the pending-return path, exempt
from the break/continue crossing rule).

**New native-lane note (C, measured, NOT fixed by this build — C is
the transitional semantics reference, out of scope for a wasm-tier
rider):** the C runtime picks up "destroy fires" for free — the new
`stream.destroyAborted` libCall is aliased to plain `stream.destroy`'s
own C codegen (`emit-exprs.ts`/`llvm/emitter.ts`), since the AbortError
substitution and the crash-suppression flag are wasm-backend-only
machinery (`stream.ts`). `break`/`return`/`throw` now destroy on C too
(same as wasm). The re-iteration crash does NOT: C never stores the
AbortError. Gate finding R2 corrected this paragraph's own prior
"unchanged from before this build" claim, which was measurably
backwards — the build DID change the C-lane observable, just not to
Node's shape. Measured, both trees, `--backend c`: on BASE (before
this rider), `break` never destroys at all (mechanism 1 did not exist
yet), so the stream is still alive when the second loop starts — it
PARKS, waiting for a chunk that never arrives, and the program exits
with that second loop unfinished (nothing printed for it). On the
FROZEN tree, mechanism 1 DOES destroy on C (shared/aliased), so the
second loop now reaches C's own destroyed-with-no-error path and
COMPLETES NORMALLY — the loop body yields no chunks, but
the statements AFTER the loop now run and print (`"C: second loop
completed normally"` / `"C: done"`), where
BASE printed neither because its loop never returned control at all.
That printed-output difference IS the changed observable this build
introduces on C; both eras still exit 0, so exit code alone does not
distinguish them. Node throws `AbortError`/`ABORT_ERR` in this shape;
neither C era reproduces that throw — both C states diverge from Node,
but they diverge DIFFERENTLY: base hangs the loop forever with no
further output at all, frozen completes it and prints those two lines
instead.

Separately, C's own natural-end machinery reacts to the shared
`destroy()` call differently from wasm's: for the async-delivered
shape-B variant above, C's `readableEnded` flips to `true` as a side
effect of the destroy call (still diverging from Node's `false`,
measured both before and after this build — NOT resolved by rider
#72, a standing C-lane-only divergence from Node this entry does not
claim to cover).

**PRE-EXISTING BUG FOUND DURING VERIFICATION, NOT caused by and NOT
fixed by this build:** a `destroy(err)` issued in the SAME TICK that a
`for await` then starts crashes the wasm tier where Node stays silent.
The same-tick qualifier is load-bearing: let a tick elapse before the
loop starts, or attach no iterator at all, and NODE crashes too — and
this tier matches it in both of those shapes (measured, reproducing on
the unmodified fe0ea5c baseline).
Board #87 carries the full observer rule and the full measured record;
not registered as an S-entry here since disposition is not this
rider's call.

## S049 — Concurrent for-await over one Readable TRAPS; Node chains via its shared cached iterator *(wasm tier traps; C lane throws — split loud shapes)*

Node caches ONE async iterator per stream, so two concurrent `for
await` loops over the same Readable chain/interleave and both
complete (measured — the increment's task brief wrongly said "throws";
corrected during pass 2). This tier parks exactly one for-await
continuation (RS_WAITER, a single slot) and builds no chaining: a
second concurrent `nextChunkDyn` while one is parked TRAPS (exit 1
per S007's uncaught-is-a-trap bridge) at the park site. The original pass-2 form
silently OVERWROTE the slot — the first loop's promise was abandoned
unsettled and the program printed truncated output with exit 0, the
silent-wrong-output class rule 1 forbids — replaced with the loud
trap in the gate's fix round. The C reference lane's `next_waiter`
model THROWS on the same shape: also loud, differently shaped, its
own Node divergence (board #69's list). No claimed corpus program
runs concurrent iteration.

**Rationale:** shared-iterator chaining is real scheduling machinery
with no claim payoff; between silent truncation and a loud trap, the
trap is the only shape consistent with rule 1. A synthesized throw
mimicking the C lane was rejected: it would imitate Node-style
failure for a case where Node does not fail, dressing the divergence
as program behavior rather than a tier refusal.

**Tested by:** corpus-unpinnable in the byte-exact contract (Node
exits 0 with MORE output; this tier exits 1 — no fixture can match
both), so the loud-trap behavior is pinned by the gate's fix-round
probe (two concurrent loops → trap, exit 1, no silent truncation);
the measurement of record is that probe plus Node's chaining output,
restated above. The nextChunkDynCore park-site comment cites this
entry.

## S050 — A second simultaneous `pipe()` destination TRAPS; Node fans out to every destination *(wasm tier)*

Node's real `pipe()` appends to an internal list (`state.pipes`) and a
single Readable can stream to any number of simultaneous Writable
destinations — every one receives every chunk, 'end' calls `.end()` on
each, and `unpipe(dest)` removes exactly one without disturbing the
rest. This tier tracks ONE active pipe relationship per source (four
scalar/ref fields on the readable-side state: destination, and the
three internal listener closures pipe() itself registers) — no list,
by construction. A second `.pipe()` call on a source that is already
piping TRAPS (exit 1 per S007's uncaught-is-a-trap bridge) at the
call site rather than either silently overwriting the first
relationship (abandoning its destination mid-stream with no error,
the silent-wrong-output class rule 1 forbids) or silently fanning out
without ever having built the list machinery to do it correctly.

**Rationale:** true multi-destination fan-out is real scheduling
machinery (a list, not a single slot, threaded through every one of
pipe's own listener closures and unpipe's own removal) with no claim
payoff this pass — none of the five claims this pass's pipe() work
targets pipes one source to more than one destination. Between a
silent overwrite and a loud trap, only the trap is rule-1-consistent,
S049's own reasoning exactly.

**Tested by:** corpus-unpinnable in the byte-exact contract (Node
exits 0 and both destinations observe every chunk; this tier exits 1
— no fixture can match both). pipeCore's second-pipe guard cites this
entry at its trap site.

## S051 — A truthy non-Error completion-callback argument TRAPS; Node accepts it as the error, unchanged *(wasm tier)*

Node's real `_write`/`_final`/`_transform`/`_flush`/`_destroy`
completion callback (`cb(err)`) decides "is this an error" by PURE JS
TRUTHINESS on the raw argument — no type check, no coercion. Measured
directly (m-cb-err-matrix.cjs, 9 values against real Node): a truthy
string, a nonzero number, `true`, and a plain (non-Error) object all
fire `'error'` with that EXACT value, unchanged — a plain `{}` stays a
plain `Object` on `.errored`, never wrapped or coerced into an `Error`
instance. In real Node, `0`, `false`, `undefined`, and an absent
argument are all falsy alike — no error, the operation succeeds,
uniformly across all four shapes. THIS TIER's own boundary is
narrower, and sits one layer BELOW this entry's own dispatch, not
inside it: the completion-callback parameter's static type is the
union `(%Error|null|undefined)`, and only the two falsy shapes that
are actually REPRESENTABLE in that union — `null` and `undefined`
(an absent argument boxes to the same `undefined`) — ever reach
S051's own truthiness check at all. `0` and `false` are NOT
representable in `(%Error|null|undefined)` at all, so they fail
LOUDLY first, at the adapter's general union-exactness coercion layer
(the FRONTEND's own checks in lowerer.ts — "a 'number'/'boolean' value
is not representable in the target union (a value narrowed or asserted
past it still held it)" — reported through S007's C5 `reportUncaught`
machinery; a DIFFERENT trap site and message than S051's own
`dynDoneClosFor` check below), before this
entry's own dispatch ever runs. Measured directly (the reviewer's own
five-shape isolation, z-falsy-{0,null,false,noarg,undefined}.cjs):
`cb(null)`/`cb(undefined)`/`cb()` all MATCH Node (falsy,
union-representable, no error); `cb(0)`/`cb(false)` both TRAP, but via
the general coercion layer's own message, not this entry's. This tier's
whole error-dispatch pipeline (`RS_ERROR`, `destroyErrCore`, the
`'error'` event itself) is typed to a real `%Error`-rooted class
reference; it has no representation for a non-Error value at all. A
truthy dyn value that genuinely IS an `%Error` instance (`dyn.isError()`, `dyn.toError()` —
the reverse of `dyn.fromError()`'s own identity-preserving cache)
extracts and proceeds normally, matching Node exactly. A truthy dyn
value that is NOT an `%Error` instance — a string, a number, `true`, a
plain object, anything else JS would accept — TRAPS loudly instead
(`dynDoneClosFor`'s own completion-callback thunk, the DYN-ADAPTER
phase's boxFn-minted "done" callback for a checked-dynamic
`_write`/`_transform`/etc. override).

**Rationale:** representing "any truthy value" for `RS_ERROR` would
require extending the WHOLE error-dispatch pipeline — the typed field
itself, `destroyErrCore`, the `'error'` event's own dispatch — to hold
an arbitrary dyn value instead of a typed class reference, real
invasive machinery with zero claim payoff today (checked: none of
1811/2313/1747/1812's own dyn-boundary callbacks, this phase's own
claim set, ever passes a non-Error truthy value as the completion
argument). Between silently coercing/dropping it and a loud trap, only
the trap is rule-1-consistent — S049/S050's own reasoning, one gate
further down the same completion-callback machinery.

**Tested by:** corpus-unpinnable in the byte-exact contract (Node
exits 0, having accepted the raw value as the error; this tier exits 1
— no fixture can match both). A probe trio: a real `Error` (MATCH — the
ordinary, exercised path), a falsy zero-arg `cb()` (MATCH — no error),
and a truthy non-Error string `cb('oops')` (the divergence itself,
node exit 0 / wasm exit 1). `dynDoneClosFor`'s own trap site cites this
entry.

Boundary pins, the reviewer's own five-shape isolation (measured
against real Node directly, then against this tier —
`z-falsy-{0,null,false,noarg,undefined}.cjs`): `cb(null)`,
`cb(undefined)`, and a bare `cb()` all MATCH (falsy, representable in
`(%Error|null|undefined)`, no error either side). `cb(0)` and
`cb(false)` both TRAP on this tier — but at the general union-exactness
coercion layer, NOT here: `Uncaught TypeError: a 'number'/'boolean'
value is not representable in the target union`, not this entry's own
"non-Error completion-callback argument" message. The two pins mark
the real edge this entry's own subject stops at.

## S052 — `rawListeners()` answers the same array `listeners()` does — the once-wrapper has no separate identity here *(wasm tier; native lanes ship the same divergence)*

Node's `emitter.once(name, fn)` registers an internal WRAPPER closure
(the thing that actually lives in the registry, which unregisters
itself and then calls `fn`); `listeners(name)` unwraps back to the
original `fn` for each once-registered entry, while `rawListeners
(name)` deliberately answers the wrapper objects themselves (each
carrying a `.listener` property pointing back at the original — Node's
own once-wrapper introspection tests exercise exactly this). This
tier's once semantics are built entirely at the RUNTIME level
(events.ts's entry `{once, fired}` fields plus the dispatch loop's own
unlink-before-invoke step) — there is no compiler-visible "wrapper
closure" object at all, only the original listener closure stored
directly in the entry. Consequently `rawListeners()` has nothing
DIFFERENT to answer than `listeners()` — both read the SAME entry
array of original identities (`entryIdentity()`'s `orig ?? clos`, the
SAME helper `listenerCount`/`removeListener` already used before this
phase — reused, not reimplemented), so the frontend lowers both
methods to the identical libCall (`emitter.listeners`,
lower-emitter.ts's own header) rather than merely computing an equal
answer by coincidence.

Two further boundaries this same mechanism names rather than silently
narrows: (1) `.listeners('error')`/`.rawListeners('error')` refuse by
name at compile time — the dedicated `'error'` bucket (this file's own
"direct-reference family", no `name`/`next` chain at all) is a
genuinely different representation `listenersOf`'s general-bucket walk
does not traverse; no claim in this phase's scope ever calls either
method with `'error'`. (2) a listener registered with a signature
NARROWER than the event's own canonical tuple (`ee.on('evt', (a:
string) => {...})` against a `(string, number)` event — legal Node,
the ordinary "extra arguments ignored" rule) needs a closure ADAPTED to
the full tuple to be a valid element of the returned array's own
uniform element type; `entryIdentity()`'s pre-existing consumers never
needed that adaptation (`ref.eq` compares any two eq-typed refs
regardless of their more specific type). Building it was deferred to
the assert era as board #75 — since BUILT (increment 22 stage D P3):
`listenersOf`'s adapter cascade now mints identity-transparent adapter
closures for narrower-arity entries (events.ts's own BOARD #75 header;
the universal unwrap keeps `===` and removal-by-original answering the
REAL listener), and 1677 claims. The `ref.test` guard's residual trap
now covers only what the cascade genuinely cannot adapt — dyn-registered
(`onDyn`-path) entries and the dedicated `'error'` bucket — reported
loudly and by name (S007's C5 reportUncaught pattern, S050/S051's own
use of it), the
ordinary out-of-tier contract, not a second observable divergence
needing its own entry.

**Rationale:** inherited from the native lanes' identical
representation choice. Two separate C-emitter comments claimed register
coverage before anything was filed: `scr_events_emitter.c`'s
rawListeners comment ("SEMANTICS.md documents the rawListeners
divergence") — a stale citation THIS entry now makes true — and its
leak-warning comment ("SEMANTICS.md documents both", where "both" means
the warning's pid AND its synchronous timing), which still resolves to
nothing (board #66; the drafted entry awaits filing). Building a separate,
corpus-invisible wrapper OBJECT purely to give `rawListeners()`
something different to point at would be representation work with no
other consumer anywhere in this tier's EventEmitter surface, so the
divergence is accepted rather than manufactured machinery to avoid it.

**Tested by:** the identity claim's coverage is a COMPOSITE of two
instruments — no single one covers it: `wasm-listener-adapters.test.ts`'s
"rawListeners() rides the identical adapter machinery (S052: no separate
identity from listeners())" pin asserts `rawListeners('evt')[1] === bare`
for an ADAPTED entry (registered `.on` with a narrower signature — board
#75's shape, not the once-wrapper); the ONCE-registered half rides
1677's own `listeners("evt")[2] === bare` (corpus line 25, claimed).
Both methods lower to the single `emitter.listeners` libCall
(lower-emitter.ts), so the two halves compose to cover this entry's
claim. 1677-emitter-listeners.ts is CLAIMED (stage D P3,
`libCall:assert.deepResult` + the board #75 adapter both landed) and
exercises the adjacent surface — `listeners()`/`rawListeners()` over a
mix of full/once entries — but reads only `rawListeners('evt').length`,
never element identity, so the corpus alone does not pin this entry.

## S053 — `pipeline()` skips its pre-flight already-destroyed check; a stage destroyed before the call settles via the ordinary premature-close route instead of a synchronous throw *(wasm tier)*

Node's real `pipeline()` validates every stage before wiring anything:
a stage already `destroyed` at call time makes `pipeline()` throw
SYNCHRONOUSLY, before returning — measured directly (node v24.18.1,
`t.destroy()` on the MIDDLE stage of a 3-stage `pipeline(s, t, w, cb)`,
called before `pipeline()`): `Error: Cannot pipe to a closed or
destroyed stream`, `code: ERR_STREAM_UNABLE_TO_PIPE`, `name: Error`,
thrown from the `pipeline()` call itself — the callback is never
invoked at all. This tier has no such pre-flight check: `pipeline()`
always returns normally, wires the pairwise pipes and the cascade
watchers exactly as if every stage were live, and the already-destroyed
stage's own idempotent `destroyErrCore` guard makes its OWN cascade
call a no-op — so the pipeline settles later through the SAME
premature-close mechanism M1 uses for a stage destroyed DURING the
pipeline (not before it): the callback fires (asynchronously, on the
ordinary tick machinery) with `Error: Premature close`, `code:
ERR_STREAM_PREMATURE_CLOSE` (measured directly against the compiled
build, the identical shape M1's own pin exercises).

The SHARPEST observable is the exit path for an uncaught case: Node's
synchronous throw means an unhandled instance crashes the process
IMMEDIATELY, at the `pipeline()` call site itself, before any stage's
own machinery ever runs; this tier's async settle means the SAME
program runs its full script body first, and only crashes (if nothing
catches the callback's error) on a LATER tick, after the cascade and
teardown have already executed — sync-throw-catchable-at-callsite vs.
async-settle-then-maybe-crash-later, not merely a different error
identity.

Measured shape (original): the MIDDLE stage (position 2 of a 3-stage
pipeline, role RW) pre-destroyed with no error — the r3a probe cited
above.

AMENDMENT (re-gate, all three positions now measured — the entry's own
"register by shape" caveat above is CLOSED, not left open): the
SOURCE position is NOT a divergence — measured directly (node v24.18.1
and the compiled build, both sides, a fresh `s.destroy()`-before-
`pipeline()` probe): Node itself returns `pipeline()` NORMALLY for a
pre-destroyed SOURCE, settling the callback asynchronously with `Error:
Premature close`, `code: ERR_STREAM_PREMATURE_CLOSE` — the EXACT same
observable this tier already produces there, byte-for-byte, no fix
needed. The MIDDLE and DESTINATION positions both carry the registered
divergence — measured directly (node v24.18.1 and the compiled build,
both sides, a fresh `w.destroy()`-before-`pipeline()` probe for
DESTINATION): Node throws SYNCHRONOUSLY, `ERR_STREAM_UNABLE_TO_PIPE`,
at BOTH positions, where this tier settles asynchronously via the SAME
premature-close route at both.

MECHANISM (why the split by position, not incidental): Node's own
error message is exact and load-bearing — "Cannot pipe **to** a closed
or destroyed stream". The pre-flight check fires on whether a stage is
a pipe DESTINATION — every stage in a chain except the source is piped
TO by its predecessor, so source is structurally exempt, never a
divergence to fix; middle and destination both ARE piped-to positions,
both need the check. This is the reason board item #81's eventual fix
must NOT be a blanket "any stage destroyed" pre-flight check — a
blanket check would make source throw synchronously too, CREATING a
new divergence at the one position that is currently correct, while
fixing the two that are not. The check belongs on the destination side
of each `pipeCore()` pairwise wiring call specifically, mirroring
Node's own "to" framing, not on `PCTX_STAGES` as an undifferentiated
list.

**Rationale:** the fix is a genuine pre-flight validation this tier's
`pipeline()` lowering does not build at all (checking each PIPE-TO
stage's own destroyed state — every stage except the source — before
ever calling `pipeCore`/registering a single watcher for it, then
throwing synchronously if already true) — registered now, landing P2's
fix round KNOWING this gap exists, rather than shipped silent; the
build is tracked as a lead-side board item (#81) for a later pass, now
scoped correctly by the amendment above (destination-side check, not a
blanket one). Divergence direction: nothing is fabricated or lost — the
pipeline still fails, with the same eventual `ERR_STREAM_PREMATURE_
CLOSE` identity M1's own mechanism already produces for the "destroyed
during" case — but the FAILURE MODE (sync-throw-before-any-side-effect
vs. async-settle-after-full-wiring) diverges at the middle and
destination positions, and an uncaught-error program's observable exit
timing diverges with it there.

**Tested by:** corpus-unpinnable today (no claimed program pre-destroys
a pipeline stage before calling `pipeline()`); the measurements of
record are this fix round's own r3a probe (stage-D P2-1 close-out,
middle position) plus the re-gate amendment's own source/destination
probes (both freshly re-measured against live Node and the compiled
build, both sides, not assumed from the reviewer's report), restated in
full above.

## S054 — A thrown `AssertionError`'s `.message` carries ONLY the header/custom text for the STATIC-COMPOSITE families — Node's trailing multi-line diff never renders there; the SCALAR family (P1) and the DYN family (P2b) are BOTH exact whole-message *(wasm tier)*

`assert.strictEqual`/`notStrictEqual`/`deepStrictEqual`/`notDeepStrictEqual`
over Buffer/Uint8Array operands (`assert.refEqBytes`/`assert.deepResult`)
OR bare-function operands (`assert.refEqFn` — the stage D P3 1681
stretch, landed after this entry's first draft; SAME divergence, same
mechanism, extending this entry's scope rather than drafting a new
one) — i.e. the STATIC-COMPOSITE family (bytes, functions, and the
arrays/records/maps/sets/unions `assert.deepResult` covers via the
synthesized structural-equality helpers), all routed through
emitter.ts's `emitAssertLibCall` — throw a catchable `AssertionError`
whose `.name`/`.code` are byte-exact to Node (`"AssertionError"`/
`"ERR_ASSERTION"`) and whose `.message` is the SAME first line Node
produces (one of a small set of static header strings, or the verbatim
custom message when one is passed) — but nothing after it. Node's real
`.message` continues past that header with a blank line and a rendered
diff of the two operands (`util.inspect`-shaped: `+ actual - expected`
markers, an indented value dump). This tier's `.message`, for THIS
family only, stops at the header, full stop — no blank line, no diff,
no trailing newline.

**Amendment (increment 23 P1):** the SCALAR family — `assert.eqF64`/
`eqStr`/`eqBool` (numbers, strings, booleans; `eqSym` when symbols
land) — is NOT covered by the header-only divergence above. Built
after this entry's first draft, emitter.ts's `emitAssertLibCall` ports
Node's real scalar diff assembler (`assertion_error.js`'s short/
stacked forms, the `+ actual - expected` markers, the `^`
first-difference caret, the 80-column caret gate, the inline-vs-block
split for `notStrictEqual`) directly — `.message` for this family is
EXACT, WHOLE, byte-for-byte, including the trailing diff S054's
original text said never renders. Own re-measurement (node v24.18.1,
`assert.strictEqual(1111111, 1111112)`), quoted in full, both sides
byte-identical: `"Expected values to be strictly equal:\n+ actual -
expected\n\n+ 1111111\n- 1111112\n        ^\n"`. The ONE exception
inside the scalar family itself is not a message-content divergence at
all: `eqStr`'s multi-line-inspection case (either operand's rendered
text spans lines) is a bare, deliberately silent SENTINEL TRAP — a
plain `unreachable`, no message ever constructed — documented at
emitter.ts's own comment on the sentinel (the eqStr case in
`emitAssertLibCall`); P2b's diff assembler replaces it (RETIRED as of
the P2b amendment below — the sentinel no longer exists; this
paragraph is P1-era history, kept for the record of what the tier used
to do, not a description of current behavior). No corpus program
reaches it (1603's longest operand pair is far too short); it is not a
false `.message` the way header-only truncation is, so it gets no
S-number of its own.

**Amendment to S027:** S027 states tier-wide that "`err.message`, `err.name`,
`err.code` and `instanceof` are all exact" for every error this tier
throws — true everywhere else, but this entry is the ONE exception, and
(per the increment 23 P1 amendment above) only for the STATIC-COMPOSITE
operand families specifically, not AssertionError messages in general:
for THOSE families, `.message` is exact only on its FIRST LINE, not its
full value. S027's own `.stack` disclaimer ("a separate question") is
unaffected and unrelated — this is about `.message` itself, a property
S027 declared exact without qualification because nothing before this
pass ever diverged there.

**Measured boundary (Node v24.18.1, own probe, re-run at this draft's
own time — not transcribed from an earlier stage of this pass; historical
record for the STATIC-COMPOSITE family, re-confirmed still current at the
increment 23 P1 amendment above — own re-check, `assert.refEqBytes`,
`Buffer.from([1,2,3])` vs `Buffer.from([1,2,4])`, this tier's compiled
build still answers the single 42-character header line, unaffected by
the scalar-family work):** for
`assert.deepStrictEqual(Buffer.from([1,2,3]), Buffer.from([1,2,4]))`,
Node's real `e.message` is `"Expected values to be strictly deep-equal:\n+
actual - expected\n\n  Buffer(3) [Uint8Array] [\n    1,\n    2,\n+   3\n-
4\n  ]\n"` — 10 lines, 121 characters. This tier's compiled build
(re-measured against the same shape via the actual host, not asserted)
produces `e.message === "Expected values to be strictly deep-equal:"` —
1 line, 42 characters, byte-identical to Node's FIRST line only. The
SAME shape holds for `assert.refEqFn`, re-measured independently at the
1681 stretch's own draft time: for `assert.strictEqual(f, g)` over two
bare functions, Node's real `e.message` is 7 lines, 123 characters
(header, a blank-separated `+ actual - expected` diff, `[Function: f]`/
`[Function: g]` lines, a caret marker) — this tier's compiled build
produces the 54-character header alone, 1 line. A program reading
`.message.split("\n")[0]` (1680 and 1681, this pass's other two named
claims, both do exactly this — 1677's own asserts all PASS, so it never
constructs or reads a message at all) observes no divergence at all; a
program reading `.message` whole, `.message.length`, or
`.message.split("\n").length` would observe the difference immediately.
`e.stack` carries no frames on this tier regardless (S027), so it is not
an independent way to recover the missing lines.

**Rationale:** reproducing Node's trailing diff requires porting a real
structural-diff renderer over `util.inspect`-shaped output (the `+`/`-`
marker walk, indentation, the composite-value dump) — genuinely new
machinery this pass does not build, named in its own design note as
explicitly out of scope. None of the three named claims (1677, 1680,
1681) ever observes past the first line — but not for the same reason
in every case: 1680 and 1681 both use a `try { ... } catch (e) { ...
e.message.split("\n")[0] ... }` pattern that reads only the header;
1677's own three `assert.deepStrictEqual` calls all PASS (their
verdicts are true), so 1677 has NO try/catch around any assert call at
all and reads `.message` ZERO times — its own AssertionError machinery
never even constructs a message, let alone observes one.
Truncating rather than fabricating a plausible-looking diff keeps the
divergence HONEST and NAMED rather than a silent approximation that
could look right by accident on some inputs and wrong on others.

**Tested by:** for the STATIC-COMPOSITE family (the header-only
divergence): `packages/compiler/test/wasm-assert.test.ts` — the
`.message.split("\n")[0]` pin mirrors 1677/1680's own corpus pattern
directly; every header-string branch across BOTH families (same-
structure, reference-equal, not-reference-equal, deep-equal, not-deep-
equal, custom message — refEqBytes's set; reference-equal, not-
reference-equal, custom message — refEqFn's own, force-pinned since
1681 itself never passes a custom message) has its own execution pin
asserting `.message`'s EXACT (whole) value, which is what makes the
truncation-not-fabrication claim durable — a pin asserting only the
split first line would not distinguish "truncated" from "correctly
reproduced the whole thing." No corpus program can pin the truncation
itself (1677/1680/1681 never read past line 0 by construction, and no
claimed program constructs a full-message read against this family) —
the unit pins are the only instrument for this entry.
For the SCALAR family (the increment 23 P1 amendment — exact whole-
message): `tests/corpus/1603-assert-scalar-messages.ts` pins the whole
`.message` for every scalar strictEqual/deepStrictEqual header and diff
form as a claimed corpus program, byte-exact against Node;
`packages/compiler/test/wasm-assert-core.test.ts` covers every
branch the corpus does not vary (the numeric-prefix caret guard, the
80-unit caret gate straddle, the ±0 case, custom-message overrides, the
inline-vs-block `notStrictEqual` split, the eqStr sentinel's own trap —
proven a TRAP and not a wrong message via the stderr-empty pins
described at that file's own header).

**Amendment (increment 23 P2b):** the DYN family — `assert.eqDyn`
(strictEqual/notStrictEqual/deepStrictEqual/notDeepStrictEqual over
CHECKED-DYNAMIC operands, values that crossed the `unknown` boundary)
— is ALSO now exact whole-message, joining the scalar family above and
narrowing S054's own remaining scope to the static-composite family
only (bytes, functions, and the array/record/map/set/union shapes
`assert.deepResult` covers). `emitAssertLibCall`'s `assert.eqDyn` case
ports Node's real `createErrDiff` decision tree (showSimpleDiff/
notIdentical/the myers branch — design-p2.txt D.1-D.9) via
`dynEqFailHelper`/`dynNeqFailHelper`, reusing P1's own `eqFail`/
`neqFail` for the simple/stacked and neq-single-line forms (D.5). D.9's
own "boxing shim" additionally routes `assert.eqStr`'s failure path
through the SAME dyn assemblers unconditionally (not gated on a
multi-line check), retiring that sentinel trap entirely — the trap
S054's own P1 amendment named above is GONE as of this pass, not
merely unreached.

Six corpus programs now claim on this family byte-exact against Node
(1770-1773/2161/2165, tier 747->753) and 14 force-emit pins
(`packages/compiler/test/wasm-assert.test.ts`, the "F.2" pins) cover
every mechanism F.1's own claim-coverage map found the six do not
reach — the notIdentical/neq >50-line collapses, the printer's
nopCount 6/7 arms, the 80-unit caret boundary, the indent-dependent
split threshold at both nesting levels, the 10000-unit cap (singular
and plural), the UTF-16 sort axis, custom messages on both families
(including the neq family's own `hasMsg`-alone bypass — see the FOUND
BUG note below), and `expectsErrDyn` (D.7)'s positive control.

**A real bug this pass's own differential caught, not review:**
`dynNeqFailHelper`'s first draft assembled a diff under a custom
message for the notStrictEqual/notDeepStrictEqual family whenever the
comparison spanned multiple lines — wrong: real Node's own
`AssertionError` constructor (`assertion_error.js:269-274`) takes
`super(String(message))` WHOLESALE whenever `message != null` for this
family (`notStrictEqual`/`notDeepStrictEqual` are NOT in
`kMethodsWithCustomMessageDiff`, unlike `strictEqual`/
`deepStrictEqual`), bypassing the diff/collapse/inline-vs-block
machinery entirely — not just replacing a header line, the way the EQ
family's own `getErrorMessage` does. `tests/harness/wasm-differential.
test.ts`'s own run against `1771-assert-dyn-deep.ts`'s "custom ndse"
line failed with the diff still attached before this was found and
fixed (a top-of-function early return on `hasMsg`, before `splitLines`
even runs) — re-verified clean afterward, both by the corpus (six-for-
six) and by mutation (reverting the fix reddens both the corpus line
and this file's own "F.2 assembler: custom message" pin by name).

**Two genuine gaps found while building the F.2 pins, neither fixed
here (both cost the six nothing):**
  (a) a Buffer value boxed across the `unknown` boundary renders as a
      PLAIN `Uint8Array` — `assert.deepStrictEqual(Buffer.from([1,2]),
      new Uint8Array([1,2]))` over `unknown`-typed operands does NOT
      throw, own re-confirmation of D.9's own already-registered "the
      dyn copy cannot carry the Buffer/Uint8Array brand" — the "Buffer
      flavour" rendering form is UNREACHABLE via checked-dynamic
      operands, not merely unbuilt; the brand stays observable only
      through the static-composite family (this file's own earlier
      `refEqBytes`/`bytesDeepEq` pins).
  (b) `expectsErrDyn`'s "errValue" classification (`lower-assert.ts`)
      tests `expectedT.className === "%Error"` by EXACT string
      equality rather than `inErrorHierarchy` (the hierarchy-aware
      helper the SAME file uses one branch up for the "class" form) —
      so `assert.throws(fn, new Error(...))` reaches `expectsErrDyn`
      but `assert.throws(fn, new TypeError(...))` (or any other
      subclass instance) refuses by name
      ("assert.throws with this expected-error shape... has no scriptc
      lowering yet"). A pre-existing frontend limitation in a file this
      pass does not otherwise touch — named here rather than fixed
      under this freeze's own time budget.

**Tested by (P2b):** `tests/harness/wasm-differential.test.ts`'s six
new `TIER_FLOOR` claims (byte-exact against live Node, both instruments
— the differential run and the tier-floor set-equality check);
`packages/compiler/test/wasm-assert.test.ts`'s 14 "F.2" pins (every
literal measured directly against live Node v24.18.1,
`scratchpad/inc23/impl-p2b/measure-f2.mjs`, not hand-derived — an
earlier hand-derivation pass for several of these literals miscounted
more than once before being replaced with parsed, measured values);
the mutation check on the FOUND BUG above (`dynNeqFailHelper`'s early
`hasMsg` return, reverted and re-confirmed both instruments red, then
green again).

## S055 — `MaxListenersExceededWarning`: the native lanes print it SYNCHRONOUSLY with their OWN pid; the wasm tier does not print it at all yet *(per-lane; filed at the increment-22 close from the stage-A draft)*

Node's leak warning ("(node:pid) MaxListenersExceededWarning: Possible
EventEmitter memory leak detected. 11 evt listeners added to
[EventEmitter]. MaxListeners is 10. Use emitter.setMaxListeners() to
increase limit") carries the CALLING process's pid and is emitted via
`process.emitWarning`, which defers the stderr write past the current
synchronous section (measured at filing: the warning prints AFTER a
marker logged after the 11th `.on()` and BEFORE a `setTimeout(0)`
callback). The lanes here diverge two ways, both unavoidable or
unbuilt:

- **C/LLVM (shipping today):** the warning prints SYNCHRONOUSLY at the
  `.on()` call that crosses the threshold — between the two markers
  Node prints it after — and stamps THIS process's own pid (never the
  oracle's; no two processes ever share one). Measured at filing: the
  C binary reproduces Node's text byte-for-byte including the
  "(node:pid)" prefix format and the "(Use `node --trace-warnings
  ...`)" hint line; only the pid value and the position differ.
- **wasm (current state):** the warning is UNBUILT — crossing the
  threshold prints nothing at all. When it lands, it will defer through
  the tier's OWN `nextTick` queue (S078, INC-26 P3) exactly as
  `process.emitWarning` itself now does — NOT the synchronous-print
  stance below, which stays the C lane's alone.

**Rationale:** matching Node's pid is definitionally impossible (this
process is never that process); matching the deferred-tick timing would
route the warning through the stage-0 nextTick queue for zero corpus
payoff, because NO lane can ever host a threshold-crossing corpus
program under the byte-exact contract: the pid alone makes exit-0
stderr matching impossible on the native lanes, and the wasm lane's
current silence mismatches Node's stderr from the other direction. The
C lane took the simpler synchronous print; the wasm lane inherits that
stance when built (an `@exit:1` fixture — stderr excluded on nonzero
exit, the S007/S010 bridge — is the only future corpus-pinnable shape,
pinning that the warning FIRES and the process continues).

**Tested by:** corpus-unpinnable in the exit-0 contract (above). The
measurements of record are the filing-day probe (11 no-op listeners on
one event, markers before/after the loop and on a `setTimeout(0)`):
Node = deferred + its pid; C binary = synchronous + its own pid, text
otherwise byte-identical to Node's including the hint line; wasm =
silent. `scr_events_emitter.c`'s leak-warning comment ("SEMANTICS.md
documents both" — the pid and the timing) cites THIS entry; filing it
closes the leak-warning half of board #66 (the rawListeners half closed
with S052).

## S056 — `deepStrictEqual`'s cycle memo runs ALWAYS; Node runs it only after a stack overflow, so a fresh Node process can answer EQUAL where this tier throws on one class of terminating cyclic shape *(all three lanes)*

`assert.deepStrictEqual`/`notDeepStrictEqual` over cycle-capable static
types (recursive records and their arrays/maps — `lower-assert.ts`'s
`deepEqHelper` cycle wrapper, `assert.deqEnter`/`deqLeave`) consult
Node's real cycle memo on EVERY comparison. Node does not. Its public
entry (`lib/internal/util/comparisons.js`'s `detectCycles`) first runs
the whole comparison with NO memo at all — plain structural recursion,
where `val1 === val2` terminates aliases — and only if that throws (a
genuine stack overflow on a non-terminating cycle) re-runs it WITH the
memo, then rebinds itself so every LATER comparison in that same
process uses the memo directly, permanently, for the rest of the
process's life. The memo itself (`handleCycles`) is two rules, not one:
at depth 1 the pair `(a,b)` is recorded and the comparison WALKS
unconditionally; at depth 2 (the immediate child of the top pair,
before any promotion), `val1===a` answers `val2===b`; `val2===b`
(without `val1===a`) answers UNEQUAL; anything else records `(c,d)` as
a second pair and WALKS. From depth 3 — the first call reached while
that second pair's own walk is in progress — the four remembered
values seed ONE Set, and from there for the rest of the comparison
(regardless of nominal depth) the rule is: both present → EQUAL,
exactly one present → UNEQUAL, neither → walk, then remove both. This
tier ports that two-rule memo exactly (all three lanes, one contract —
`packages/runtime/src/scr_assert.c`'s `scr_assert_deq_enter`/
`scr_assert_deq_leave`, mirrored in the wasm backend's own state
machine) but applies it UNCONDITIONALLY — Node's stack-overflow gate
around the whole memo is not ported.

**Where the two disagree (measured, node v24.18.1, plain objects,
`interface Y { x: Y | null }`; `y.x=y`; `b={x:y}`; `a={x:b}`;
`c={x:a}`; own probes, `scratchpad/inc23/lead-probe/table.mjs` run
`--pre` for a fresh process and `--post` after forcing an unrelated
overflow, re-run at filing):**

    shape                     fresh Node   Node after any overflow   this tier
    crossed depth-2 (a,b)     EQUAL        EQUAL                     EQUAL
    crossed depth-3 (c,a)     EQUAL        UNEQUAL                   UNEQUAL
    period 1v2 / 2v4 / 2v3    UNEQUAL      UNEQUAL                   UNEQUAL
    period 1v1 / 2v2 / 3v3    EQUAL        EQUAL                     EQUAL
    shared leaf, self vs {x:self}, two self-loops: EQUAL everywhere
    the genuine val2===b arm (b={x:b} vs a left operand whose field is
      some OTHER object): UNEQUAL everywhere, both Node modes
      (regression net, not a disagreement — own re-measure,
      rev/probe/val2.ts)
    stale state after a THROWN cyclic assertion (reusing the FAILED
      comparison's own operands immediately afterward): no leak —
      EQUAL where genuinely equal, in every lane, holding even on the
      PRE-F2 tree (own re-measure, rev/probe/stale.ts, 7 rows) — this
      entry's memo change PRESERVES the property, it does not build it

**A second route into the SAME class — a SIBLING'S promotion, not
nesting depth (own re-measure, `interface T { p: T | null; q: T | null
}`; own probes `scratchpad/inc23/rev/probe/sib2.ts` for a fresh process
and `sib2post.mjs` — the same shapes preceded by a period-2-vs-4 primer
that forces the overflow — for the POST-overflow column; both re-run at
filing, not transcribed):**

    shape (both siblings are depth-2 children of one top pair)   fresh Node   Node POST   this tier
    A  sibling 1 shallow (no promotion); sibling 2 = (tb, w)      EQUAL        EQUAL       EQUAL
    B  sibling 1 PROMOTES; sibling 2 = (tb, w), same as A          EQUAL        UNEQUAL     UNEQUAL
    C  no sibling at all — the plain crossed-depth-2 shape         EQUAL        EQUAL       EQUAL
    D  the val1===a arm reached via a sibling, both self-cyclic    EQUAL        EQUAL       EQUAL
    E  the val2===b arm reached via a sibling                      UNEQUAL      UNEQUAL     UNEQUAL

Row B is the second route: sibling 2's pair `(tb, w)` — `tb` the
depth-1 right operand, `w` a fresh object structurally equal to it —
disagrees with row A's IDENTICAL pair only in whether sibling 1's OWN
walk happened to promote the set first. Both siblings sit at the SAME
nominal depth (2, immediate children of the top pair); nesting depth
does not change between A and B. Rows C–E are regression-net rows
(every mode and lane already agree) confirming the ordinary crossed-d2
shape, the `val1===a` arm, and the genuine `val2===b` arm are each
unaffected by a sibling's presence.

The divergence class: a TERMINATING structure in which one operand of
a pair aliases a value from the other column of an earlier pair, ONCE
THE SET EXISTS — reached either by nesting to depth 3 (the "crossed
depth-3" row above) or, at depth 2, by an EARLIER SIBLING's walk having
promoted it (row B). Both routes land in the same class because the set
rule, once the set exists, applies "for the rest of the comparison
regardless of nominal depth" (this entry's own mechanism paragraph,
above) — row B is simply that sentence's own consequence at the
nearest depth it can occur. A fresh Node process (no overflow yet in
that process) answers EQUAL on every shape above by plain recursion;
this tier answers UNEQUAL wherever Node's OWN post-overflow column does
— a thrown `AssertionError`, never silent output. After the first stack
overflow anywhere in a Node process, its own answer flips and agrees
with this tier on every shape measured. Node's own answer is therefore
order-dependent
within a single process: the identical assertion, run twice with the
identical arguments, passes the first time and throws the second if an
unrelated comparison overflowed in between (witness, own probe,
`scratchpad/inc23/rev/probe/witness.mjs`, re-run at filing: crossed
depth-3 BEFORE any overflow → EQUAL; a period 2-vs-4 ring pair forces a
real overflow and the permanent rebind → THREW; the SAME crossed
depth-3 shape, freshly built, immediately after → THREW, and again
THREW on a third fresh instance — the rebind is process-wide and
permanent, not shape-specific).

**Rationale (Joe's ruling, 2026-08-26, OPTION A over OPTION B):** the
exact overflow behavior is not portable — Node's switch fires on V8's
real stack limit (platform, `--stack-size`, the caller's own call
depth, frame sizes), which no runtime here can observe. Option B
(emulate `detectCycles` with a depth budget standing in for the
overflow, then rebind a process-wide flag) was considered and
REJECTED: any depth budget would replace one measurable, narrow
divergence with an unlocatable boundary that could fire at a different
point than V8's real one on every platform, and the process-wide
rebind would make an assertion's verdict depend on unrelated EARLIER
comparisons elsewhere in the same run — a corpus program's own output
would then depend on execution order in a way this tier's contract
does not otherwise permit. Option A (this entry): the memo runs
always, deterministically, matching Node's own POST-overflow behavior
exactly and diverging from a truly FRESH Node process on exactly the
one narrow, terminating shape class above.

**Provenance of the bug this entry supersedes:** before increment 23
the memo on all three lanes answered EQUAL for ANY pair already being
compared (a plain pair-memo), which wrongly made a 2-node ring compare
equal to a 4-node ring (Node throws on every period mismatch, including
exact multiples). Fix round F1 replaced that with the general
set-of-values rule — correct for the period shapes — but applied it
from the FIRST comparison, which wrongly answers UNEQUAL on the crossed
depth-2 shape above (gate finding F-1): Node is still on its `a`/`b`
two-slot pair check there and has not promoted to a set, so it WALKS
that pair instead of consulting set membership. Fix round F2 ported the
two-rule memo exactly, fixing the crossed depth-2 regression while
keeping the period fix. The "crossed depth-2" row above is EQUAL in
BOTH of Node's own modes and is the regression net for that history;
the "crossed depth-3" row and sibling row B are the rows where this
tier's deterministic choice and a truly fresh Node process disagree —
two reachable ROUTES into the one divergence CLASS this entry
registers, not two separate divergences (fix round F3, gate re-cert
finding R-1: an earlier draft of this paragraph and the scope sentence
above named depth-3 nesting as the only route, which its own mechanism
paragraph already contradicted — corrected here, row B added).

**Tested by:** `tests/corpus/2693-deep-equal-cycle-period.ts` (the six
period shapes plus a shared-subtree case, three lanes — the F1
regression net) and `tests/corpus/2694-deep-equal-cycle-crossed.ts`
(the crossed shapes on a DIRECT record field, both depth-2 orders and
both depth-3 orders, PLUS — fix round F3 — sibling shape B and its
shape-A control on a two-field `T`-typed record, the second route into
this same class; depth/sibling-promotion is the axis 2693 never varies,
since its cycles sit behind an array field; 2694 opens with a period-mismatched
trigger pair so Node's OWN process has already overflowed-and-rebound
by the time it reaches the crossed-depth-3 checks, making the
byte-exact comparison against the oracle genuine rather than a
workaround — see 2694's own header). `packages/compiler/test/
wasm-assert-core.test.ts` pins every row of the "this tier" column
including both crossed-depth-2 orders, both crossed-depth-3 orders
(must-stay-THREW regression pins), the genuine `val2===top.b` depth-2
arm AND its `val1===top.a`-mismatch sibling as their own code paths
(rev/probe/val2.ts's exact shapes — a self-cyclic operand paired with
an UNRELATED plain leaf on the other side, not the first attempt's
flawed shape, which resolved via an unrelated type mismatch one level
down and would have passed even with that arm removed), a depth-≥3
exactly-one-present case (the crossed-depth-3 pin doubles as this), and
the stale-state PROPERTY (rev/probe/stale.ts's 7-row shape, reusing the
FAILED comparison's own operands — holds already on the pre-F2 tree by
construction, per scr_assert.c's own invariant that the emitted walks
cannot throw mid-compare; F2 preserves it, it does not build it).
Fix round F3 adds: sibling row B, both orders, as its own must-stay-
THREW regression pin, plus rows A/C/D/E as regression-net pins (the
T-typed `p`/`q` fields on the SAME record type as the top pair are what
make the pair-check arms reachable at all — a `Y`-typed field, as an
earlier probe used, makes `val1===memos.a`/`val2===memos.b` unreachable
by construction and tests nothing about this axis); and the depth-2
SET-POP's own dedicated pin (rev/probe/sib4.ts's two pop-observable
rows plus its no-promotion control) — gate re-cert finding R-2: this
mechanism (Node's `set.delete(c); set.delete(d)` on depth-2 exit,
mirrored in both scr_assert.c and the wasm helper) was LIVE and
correctly implemented but had NO pin; removing it left every existing
pin green.
Mutation-confirmed, own checks, reverted before freeze (re-run against
the FULL post-F3 pin set, not assumed to carry over from F2's own
narrower set): applying the general set rule at depth 2 turns the
crossed-depth-2 pin red AND, within the sibling A/C/D/E regression-net
pin, its A and C rows specifically — under that mutation the TOP-LEVEL
pair itself is pushed into the set immediately, so sibling 2's reused
top-level operand (`tb`) is wrongly "present" from the very first
comparison in A and C's shapes (a genuinely different failure mode from
crossed-depth-2's own, sharing only the root cause); D and E, and the
val2===b/val1===a-mismatch pin, are unaffected (their sibling-2 pair
does not reuse a bare top-level operand the same way). Treating
"exactly one present" as WALK turns the period-mismatch pins, the
crossed-depth-3 pin, the stale-state pin, AND sibling row B red (all
four resolve through that one arm); dropping ONLY the depth-2 set-pop
turns ONLY sib4's two pop-observable rows red, its no-promotion control
and every sibling A–E row unaffected (R-2, confirmed). Two DISTINCT
`deqLeave`-adjacent mutations, precisely: dropping only the final
depth-counter decrement (so depth never returns toward 0) turns TWO of
the 31 pins red — the crossed-depth-2 pin, AND the sibling A/C/D/E
pin's own A and C rows specifically (D and E untouched) — the corrected
mapping (gate re-cert finding, P5, itself corrected a second time at
fix round F4 after an F3-round draft undercounted it as "ONLY" the
crossed-depth-2 pin): the NEXT top-level comparison is wrongly treated
as a depth-2 child of the stale prior top pair, and A/C's own
sibling-2 pair reuses a bare top-level operand the SAME way
crossed-depth-2's own pair does, so the identical root cause surfaces
in both places, not just one; it does not surface on the leak pin;
dropping only the depth-1 full reset's length-zeroing
line ("leak-no-len-reset") turns ONLY the pre-existing leak pin red by
name, confirming that pin still discriminates under F2's depth-counter
design. Nothing
pins the fresh-Node column — it is Node's own pre-overflow behavior,
unreachable by a deterministic port by construction; `lead-probe/
table.mjs` and `rev/probe/witness.mjs` are the record.

## S057 — `assert.eqDyn`'s renderer implements a real `depth: 1000` elision option whose boundary real Node cannot reach via ordinary nesting AT THE DEFAULT STACK SIZE *(wasm tier)*

`assert.eqDyn`'s failure-message renderer (`%w.insp.cfValue`,
`inspect.ts`, increment 23 P2a) elides a composite past 1000 levels of
`recurseTimes` (`rt`), rendering `[Object]` / `[Array]` / `[Uint8Array]`
/ `[Object: null prototype]` in place of its content instead of
recursing further. This is a literal, faithful port of a REAL Node
option — lifted VERBATIM this pass via `process.binding("natives")
["internal/assert/assertion_error"]` (14267 bytes, sha256
`41ebb0538f7707b1…`, since the earlier design-doc citation did not
survive a scratchpad purge), `inspectValue`'s own option block at
that source's line 78:

    { compact: false, customInspect: false, depth: 1000,
      maxArrayLength: Infinity, showHidden: false, showProxy: false,
      sorted: true, getters: true }

`depth: 1000` is `inspectValue`'s own `recurseTimes > ctx.depth` gate.
The wasm arm implements this gate exactly as `rt > 1000`
(`ASSERT_RENDER_DEPTH_OPTION`, `inspect.ts` — see below for why this is
a SEPARATE constant from S029's `MAX_DYN_DEPTH`).

**CHAIN CONVENTION** (stated explicitly, per fix round F2-p2a, so this
entry's numbers and any other record of the same phenomenon reconcile
by convention rather than by apparent disagreement): `n` counts WRAPPER
objects placed AROUND a leaf object —

    let o = { leaf: 1 }; for (let i = 0; i < n; i++) o = { a: o };

— so the leaf sits at depth `n`, and `inspect` is called on the
outermost wrapper. A convention that counts the leaf as one of the `n`
wrappers reads the identical physical structure ONE HIGHER for the
same boundary; neither convention is wrong, they merely start counting
from a different place.

**Node cannot reach this boundary via ordinary nesting AT THE DEFAULT
V8 STACK SIZE** (own probe, `scratchpad/inc23/impl-p2a/depth-search.
mjs`, sha256 `600e04d169ef508d…` — the file that actually PERFORMS the
search below; an earlier citation to `renderer-depth.mjs` was wrong: that
file is a flat sequence of `inspect` calls in ONE process with no
binary search and no per-process isolation, and does not contain the
measurement it was cited for). A clean, ISOLATED binary search — a
FRESH `node` process per probe point, ONE `inspect` per process, three
independent launches — converged identically across all three:

    run 1: full at n=928, interrupted at n=929
    run 2: full at n=928, interrupted at n=929
    run 3: full at n=928, interrupted at n=929

**n=928 renders in full, n=929 interrupts, reproducibly, on this
machine.** (This entry previously recorded n=1249/1250 from a search
that was, on inspection, ALSO run correctly in isolation but whose
result does not reproduce under re-measurement: direct spot checks at
n=1248/1249/1250/1251 now all show INTERRUPTED, at the identical
saturated output length — 1249/1250 was never a boundary, and the
number this entry once called "cruder and superseded" — n≈928/930 — was
the one closer to correct. Both the discarded number and this one
demonstrate the same underlying instability S029 already documents:
Node's own V8 stack-exhaustion point is not a fixed depth and can shift
between re-measurements, machines, or even library/runtime versions —
"there is no fixed depth to state" is S029's own phrase for exactly
this, at a wider observed spread, 929-2450.) Node hits this stack
exhaustion BEFORE the `depth: 1000` option's own `rt > 1000` check is
ever evaluated, at the default stack size — this is the SAME family
S029 registers for the console.log dyn walker; S029's own resolution
(a FIXED cap reproducing Node's degradation SHAPE, not its exact
unreproducible boundary) is the direct precedent for this entry, at a
different call site with a DIFFERENT marker text (S029's own text is
Node's stack-overflow-RECOVERY string; this renderer's four forms are
what Node's OPTION would produce if Node's own implementation could
reach it) — filed separately rather than amending S029 for that reason.

**AT A RAISED STACK SIZE, NODE REACHES THE REAL GATE CLEANLY — the
unreachability above is scoped to the DEFAULT stack, not to Node in
general.** Own probe, same file, `node --stack-size=1200`, ONE PROCESS
PER ROW:

    n=999   full,   elided=false, leaf present
    n=1000  full,   elided=false, leaf present
    n=1001  elided (renders "[Object]"), leaf absent
    n=1002  elided (renders "[Object]"), leaf absent

This is `depth: 1000`'s own `recurseTimes > ctx.depth` boundary,
reached exactly where the option says it should be — Node CAN serve as
a byte-exact oracle for the real threshold, given enough stack; the
wasm-side pin below exercises exactly this comparison, not merely a
spec-derived one.

**The FORMS are confirmed genuine, per-process isolated, at the raised
stack, at the real n=1001 boundary** (own probe, same file): each of
`[Object]` / `[Array]` / `[Uint8Array]` / `[Object: null prototype]`
renders correctly when its own shape is inspected ALONE in its own
process. Isolation matters: running the SAME check sequentially in one
process (own probe, `sequential-warmup` mode, default stack, three
back-to-back inspects of the identical n=1000 object shape) gives
`INTERRUPTED, INTERRUPTED, FULL` — the process's available stack
changes as it warms up, so a sequential probe's later rows can look
like they "confirm" elision forms that are really just artifacts of
call order, not of the shapes. This is exactly the defect the earlier
citation to `renderer-depth.mjs` had: its rows are internally
inconsistent for precisely this reason.

**`ASSERT_RENDER_DEPTH_OPTION` vs. S029's `MAX_DYN_DEPTH`:** kept as
TWO SEPARATE constants (both currently `1000`) rather than one shared
value. They mean different things: `MAX_DYN_DEPTH` is this tier's OWN
substitute for Node's unbounded, stack-dependent crash point under
`depth: null` (a divergence, chosen to land near Node's observed
range); `ASSERT_RENDER_DEPTH_OPTION` is a literal port of a real
Node OPTION VALUE that assertion_error.js actually passes. The two
numbers coincide today by accident, not because the mechanisms are
the same, and must not be collapsed into one constant on the strength
of that coincidence — a future change to either walker's own number
(S029's own cap, chosen to approximate a moving stack-dependent
target, is the more likely one to ever move) must not silently drag
the other along.

**Rationale:** reproduce the documented MECHANISM (a real, named
option every `assert.deepStrictEqual`/`assert.deepEqual` failure
message already passes to `inspect`) rather than either leaving the
renderer's recursion unbounded (S013/S026/S029 already establish this
is unsafe on the wasm stack) or inventing a divergent threshold with
no basis in Node's own source. At the DEFAULT stack size Node cannot
be the byte-exact oracle for the real boundary — the divergence this
entry registers is scoped to that ordinary case, matching how any
compiled program actually runs `assert`. At a RAISED stack size Node
reaches the real gate cleanly, so the threshold is verified two ways:
against Node directly, at the real value, under a raised stack (the
pin below); and by mutation, which needs no raised stack and runs
everywhere (F-3's own pattern, kept as a second, independent proof
that the constant is genuinely read).

**P-4 (increment 23 P2b checkpoint-2 addendum): near this SAME seam, a
THIRD outcome exists, and it is NOT confined to bare `inspect()`
calls.** For a deep-but-finite operand, real Node yields one of {the
full message; the "Inspection interrupted" message; an UNCAUGHT
`SyntaxError` ("Invalid regular expression: … Stack overflow") from
`RegExp.exec` inside `formatProperty`'s own `keyStrRegExp` check —
Node's `handleMaxCallStackSize` catch recognizes only `RangeError`, so
this escapes uncaught} — and this third outcome can escape
`assert.deepStrictEqual` ITSELF, not just a standalone `inspect` call.
Own re-measurement, TWO independent constructions calling
`assert.deepStrictEqual(deepChain, {x:1})` wrapped in `k` extra JS call
frames, swept over n=880..936 × frames=0..3: the lead's own
`lead-probe/crash-assert2.mjs` (sha256 `a3da9bdb2f2ec0c8…`, a
ternary-recursion frame-adder over a `for`-built chain) and this
entry's own, deliberately differently-shaped
`impl-p2b/my-crash-assert.mjs` (sha256 `988e8cd0f33041b8…`, a
`wrap(k,f)` recursion over an `Array.prototype.reduce`-built chain)
agree that EVERY tested frame count renders full through n=927 and
interrupts from n=929, but disagree on which SINGLE frame count lands
the `SyntaxError` at n=928 — frames=1 for crash-assert2.mjs, frames=0
for my-crash-assert.mjs, on the SAME machine, same session, same node
binary. (Reconciling with the bare-`inspect()` sweep this entry's own
P-4 discussion started from — `impl-p2a/depth-search.mjs`'s
`frames-outcome` mode, sha256 `4af41ecfd5663f6d…`, and rev-23's
`rev/p2a/probe/frames.mjs`, sha256 `46a281d36fae6de2…`, at frames
0/1/2/5 over a bare `inspect()` call: the SAME
three-outcome shape and the SAME non-linear frame-count instability —
one phenomenon observed at two different call-chain depths, not two.)
An earlier, single-script measurement (never filed) suggested `assert`
avoids this window because its own deeper call chain sits past the
narrow crash band; that does not hold in general — the seam CAN fall
inside `assert.deepStrictEqual`'s own call chain, and exactly WHERE
depends non-linearly on the CALLING SCRIPT's own baseline stack
footprint, not on `n` alone, as the frames=0-vs-1 disagreement above
demonstrates without even changing machines. No corpus program
approaches n≈928 (this entry's own default-stack boundary above is
already unreachable by a wide margin), so this remains unreachable in
the corpus; filed here rather than as a new S-number because the
underlying mechanism is the SAME "V8's own stack-exhaustion point is
not a fixed, reproducible depth" finding S029/S057 already register,
merely observed one call-chain layer deeper (inside `assert`'s own
frames, not only inside `inspect`'s).

**Tested by:** `packages/compiler/test/wasm-assert-dyn.test.ts`'s
"cfInspect: depth elision fires past rt=1000" pin (spec-derived
oracle, own construction, run-everywhere) — a WASM-SIDE LOOP (not JS
recursion, so only the wasm call stack is exercised, never Node's)
builds a 1002-level object chain around a NUM leaf (NUM never elides
regardless of depth, so the INNERMOST OBJECT itself must be the one
evaluated past the boundary) and confirms `[Object]` appears with the
leaf absent; a 1001-level chain (one wrap fewer) confirms the leaf
renders in full. THE REAL-BOUNDARY PIN, "cfInspect: real Node boundary
at a raised stack size" — gated on the OS thread stack limit (SKIPPED
by name unless comfortably above the chosen `--stack-size`, since
`--stack-size` above the OS limit crashes the child with SIGSEGV rather
than raising a catchable error; positive-controlled by running the
gate itself under a lowered `ulimit -s` and confirming it SKIPS rather
than segfaults) — spawns `node --stack-size=1200` as the oracle, one
process per row, asserts the child exited 0 with parseable output
BEFORE interpreting it, and compares the wasm renderer's own output for
the identical chain byte-for-byte against Node at n=1001 (elides) and
n=1002 (elides) against the real threshold, not a mutated one. Own
hand-verified mutation (F-3's straddle pattern, NOT a standing pin —
temporarily lowering `ASSERT_RENDER_DEPTH_OPTION` from 1000 to 2 and
comparing a wasm-built 4-level and 3-level chain against REAL Node's
`inspect(x, {...options, depth: 2})`, re-run this fix round): both
matched Node BYTE-FOR-BYTE at the mutated, genuinely reachable
threshold, confirming the constant is actually READ by the elision
check (not dead code). Reverted before this entry was filed both
times; the constant is `1000` in the merged code, and the wasm call
stack itself is confirmed to survive 1002+ levels of `cfValue`
recursion without overflowing (the same spec-derived pin, un-mutated).

## S058 — `assert.eqDyn`'s renderer traps by name on a cyclic operand instead of rendering Node's `<ref *N>`/`[Circular *N]` protocol *(wasm tier)*

Node's `util.inspect` (and therefore `assert`'s own failure-message
renderer, which calls the same machinery) detects a value that
references itself — directly or through intermediate objects/arrays —
and renders it with a `<ref *N>` marker at the first occurrence and
`[Circular *N]` at each re-entry, both at top level and inside an
assert failure diff. This tier's renderer (`cfValue`, `inspect.ts`)
does NOT implement that protocol. Instead, re-entering a value already
on the CURRENT render path traps — a bare `unreachable` at a
documented call site (`cfSeenCheck`'s own arm in the ARR and OBJ kind
checks), not a placeholder and not the P2a-era depth-elision
degradation (a merely-very-deep, non-cyclic structure still elides
normally at `rt > 1000`, unchanged — the trap fires on RE-ENTRANCY,
never on depth alone).

**Reach: zero in the corpus.** None of increment 23's six claimed
programs (1770/1771/1772/1773/2161/2165) constructs a cyclic operand
to a failing `assert.eqDyn` comparison — the comparison SIDE already
handles equal cycles correctly via the memo (S056, B.4), so a cyclic
value that COMPARES EQUAL never reaches the renderer at all; only a
cyclic value on the losing side of a FAILING comparison would reach
this trap, and no such program exists yet.

**Amendment (increment 23 P2b close, the memo-rows ruling) — the exact
reach statement, and the trap is now NAMED:** any FAILING `eqDyn`
assertion (`strictEqual`/`deepStrictEqual`/their negations) whose
operand is cyclic reaches the renderer and traps BY NAME — an uncaught
wasm trap with this entry's own diagnostic on stderr
(`"Uncaught cfValue: cyclic value encountered while rendering an
assert.eqDyn failure message (SEMANTICS.md S058)"`), non-zero exit —
where Node throws a catchable `AssertionError` rendered with
`<ref *N>`/`[Circular *N]`. **Try/catch cannot observe it.** Passing
assertions over cyclic operands are unaffected (no render ever runs,
whatever the memo's verdict). That is the honest tier boundary until
the `<ref *N>` protocol is built.

The trap itself changed this pass from a bare `unreachable` (what the
paragraph above described, and what CLAIM 0's own pin still confirms
at the wasm-trap level — the underlying instruction is still
`unreachable`, un-catchably) to one that PRINTS first: `InspectDeps`'
new `namedTrap(c, message)` stashes `message` on the shared uncaught-
exception cell as an `EXC_STR` value and calls the SAME
`%w.err.reportUncaught` reporter S007's own uncaught-throw path uses
(`"Uncaught " + <rendered cell>`, then `unreachable`) — directly, not
through the normal pending-cell unwind (no caller anywhere checks or
rethrows; the call sits deep inside `cfValue`'s own recursion and
simply ends the program right there), which is exactly why it stays
uncatchable despite reusing the "print the reason" reporter a genuine
uncaught throw does. Both `cfSeenCheck` call sites (the ARR and OBJ
arms) now call `namedTrap` with the identical message text. This was a
P2b defect fixed at register time, not a new divergence: rule 1 (out-
of-tier constructs refuse loudly, never bare) already required it, and
the memo-rows pins below are what makes the trap REACHABLE at all
(previously zero corpus/pin reach, per the paragraph above) —
confirmed end to end (six pins, five reaching the trap under the
inverted-arms mutation, one correctly not reaching it — see "Tested
by" below) and confirmed uncatchable by direct construction (a
`try`/`catch` wrapped around the failing comparison never runs its
`catch` block; own probe, not transcribed).

**Why a named trap and not the full protocol:** design-p2.txt's own
A.6 estimates the `<ref *N>` protocol at ~120 emitter lines and a
two-pass (or backpatching) design — the marker has to be PREPENDED to
a value whose cycle is only discovered after its children are already
formatted, which this renderer's single streaming append buffer cannot
do without a second pass. That is a disproportionate share of the
pass for zero corpus claims, and a loud, distinct trap is preferable
to either (a) silently reusing the SAME text a genuinely-deep-but-
finite structure gets (which would make a cycle indistinguishable from
an ordinary deep value in the rendered output — a wrong answer, not
merely an incomplete one) or (b) recursing until the wasm call stack
overflows (an UNCATCHABLE trap, per the S003/S007 abort family, with
no diagnostic at all).

**The mechanism reuses, unchanged, the console.log dyn walker's own
growable seen-stack storage** (`seen()`/`nseen()`/`growEq`, already
built for that walker's OWN `<ref *N>`/`[Circular *N]` protocol,
`circCheck`/`seenPush`/`refWrap`) via two new, deliberately SIMPLER
methods — `cfSeenCheck` (a plain existence test against the current
path, no circular-id bookkeeping) and `cfSeenPop` (a plain pop, no
`<ref *N>` labeling). Sharing the storage is safe because the two
walkers (console.log's and assert's) are never active on the same
native call stack simultaneously, and the shared `nseen` counter
returns to 0 between any two independent top-level walks — confirmed
by running the full pre-existing wasm-inspect.test.ts suite (the
console.log walker's own 40 pins, including its own cycle-rendering
pins) unchanged alongside this addition.

**Rationale:** consistent with `%w.dyn.strictEq`'s and `deepEqDyn`'s
own precedent for HANDLE/JSVAL (dyn.ts's own established idiom: "no
Node-exact render, no approximation — the trap is the loud answer, not
a placeholder") and with rule 1 (out-of-tier constructs refuse loudly,
never miscompile) applied to a shape that is IN tier for the
comparison side but has no cheap, correct rendering this pass.

**Tested by:** `packages/compiler/test/wasm-assert-dyn.test.ts`'s
CLAIM 0 pin — a self-referencing OBJECT (`{self: <itself>}`) and a
self-referencing ARRAY (`[<itself>]`), each built via the SAME box
stored back into its own single entry, both confirmed to trap with
`/unreachable/` rather than complete. A companion pin proves the
seen-stack's own scoping is correct — NOT "ever seen at all" but
"currently on this path": a single shared (non-cyclic) COMPOSITE
value referenced from two SIBLING keys of one object renders normally
(live-Node-compared, byte-exact), confirming the trap fires on
re-entrancy and not on any repeated reference. Mutation-confirmed
(own hand-verification, reverted, hashes equal before/after): removing
BOTH `cfSeenCheck`-arm traps (a no-op in their place) turns the CLAIM 0
pin red by name — the mutated build completes normally instead of
throwing, falling through to the pre-existing depth-elision path after
~1000 recursive dives, exactly the degradation this entry exists to
retire — while every other pin in the file (including the shared-
reference control and the ordinary depth-elision pins) stays green.

**Tested by (P2b close, the memo-rows ruling):**
`packages/compiler/test/wasm-assert-core.test.ts`'s seven "assert.eqDyn
memo row" pins — S056's OWN measured shapes (period 1v2/2v4/2v3,
period-match, crossed depth-2/depth-3 both orders on the same y/b/a/c
chain, SIBLING shape B both orders, non-promoting SIBLING shape A),
ported to plain UNTYPED `.cjs` (dyn-native from birth) and observed
through the COMPLEMENTARY assertion that passes silently for each
row's own verdict (`notDeepStrictEqual` for the UNEQUAL rows,
`deepStrictEqual` for the EQUAL ones — see the pins' own header
comment for the two construction hazards found and worked around: a
function-returned or array-cross-assigned ring misinfers its own
static shape and throws a boundary TypeError; independently-
constructed cyclic shapes sharing one compiled program corrupt each
other's inference). Mutation-confirmed (own hand-verification,
reverted, hash of `emitter.ts` equal before/after): swapping the two
verdict constants at all five `deqEnterHelper` return sites (the
"inverted arms") flips every row's verdict, so the previously-silent
complementary assertion now FAILS on six of the seven — the render
runs, `cfValue` reaches a cyclic operand, and `%w.err.reportUncaught`
fires (confirmed in every reddened stack trace), reddening those six
BY NAME; the seventh (non-promoting sibling A) stays green under the
SAME mutation, exactly as it must — S056's own text already establishes
shape A never nests deep enough or gets promoted by a sibling to reach
either mutated arm, so it is compared by ordinary structural walking
throughout, the ARM-REACHABILITY control this trap's own reach
statement needs. Confirmed uncatchable directly: a `try`/`catch`
wrapped around a reddened comparison's own call never reaches its
`catch` block (own probe, not transcribed) — stdout and the absence of
a caught-branch print are identical with or without the wrapper.

## S059 — the assert renderer emits the NO-COLOR, FIXED-80-COLUMN configuration unconditionally — real Node's colored character-diff path and its terminal-width-dependent caret budget are both out of scope *(wasm tier)*

Node's real `assert` failure-message renderer branches on
`colors.hasColors` (true only when `process.stderr` is a color-capable
TTY) in TWO independent places, and this tier ports NEITHER branch —
it always renders the configuration Node itself renders when piped
(which every compiled program's own stdio always is):

  (a) **THE COLORED PATH IS A DIFFERENT RENDERER, NOT A DECORATED ONE.**
      `getColoredMyersDiff`/`printSimpleMyersDiff` (myers_diff.js) are
      NOT character-level decorations of the plain stacked/myers forms
      this tier ports (design-p2.txt D.1-D.9) — they are a WHOLLY
      SEPARATE character-by-character diff over
      `StringPrototypeSplit(s, '')` (individual characters, not lines),
      under an `actual`/`expected` header with no `+`/`-` markers at
      all. Own re-measurement (`node --force-color`, live process,
      re-run this pass): `assert.strictEqual("abcdef", "abcdef!")`
      under color becomes `"…strictly equal:\n\x1b[32mactual\x1b[39m
      \x1b[31mexpected\x1b[39m\n\n'…\x1b[31m!\x1b[39m…'\n"` — a
      character-granular insert marker over the literal quoted string,
      structurally unrelated to the LINE-granular stacked/myers forms
      this tier's own D.1-D.9 machinery produces. Porting "the colored
      form" is therefore not an incremental addition on top of what
      exists; it is a second, parallel assembler this pass does not
      build.
  (b) **THE 80-COLUMN CARET BUDGET IS A CONSTANT, NOT A TERMINAL READ.**
      Real Node's own `maxTerminalLength` is
      `process.stderr.isTTY ? process.stderr.columns : 80` — under any
      NON-TTY stderr (every compiled program's own stdio, own
      re-confirmation via the harness's own pipe) this is always
      exactly `80`, so this tier's own `eqFailHelper`/`dynEqFailHelper`
      caret gate (`LA+LB<=80`, D.2/S054's own P1-era code) is Node-exact
      for every reachable case — but it is a literal `80`, not a read
      of an actual terminal width, so a program whose own stdout/stderr
      genuinely IS a TTY with a different column count would diverge
      from Node under THAT specific circumstance. No corpus program (or
      any program compiled by this tier, since the ABI's own stdio
      contract is a pipe — `abi.ts`) can construct that circumstance.

Both halves are the SAME underlying fact — the emitted program renders
the configuration Node renders "when it has no stderr to interrogate,"
unconditionally, because it never has one — so they are registered
together rather than as two entries. This is scr_assert.c's own
dangling "SEMANTICS.md 103" citation (its header comment named a
divergence and cited a section number that never got a matching entry
— board #66's own remainder from an earlier increment's stage-A draft)
made real at this freeze; that citation is corrected to `SEMANTICS.md
S059` in the same commit as this entry, per the increment 23 P2b
close's own §3(b) item.

**Rationale:** both the colored renderer and a live terminal-width read
require information (`process.stderr`'s own TTY-ness and column count)
this tier's ABI does not model at all — every emitted program's own
stdio is a pipe by construction (`abi.ts`), so `process.stderr.isTTY`
is always false and `colors.hasColors` is always false for any program
this tier could ever run. Porting either branch would add a full
second assembler and a terminal-width import for a configuration no
compiled program can ever reach — the DEFAULT (no-color, 80-column)
configuration is not an approximation of Node's behavior here, it is
Node's own real behavior under the EXACT stdio shape this tier's own
programs always have.

**Tested by:** no corpus program or unit pin distinguishes this from
"Node's own real behavior" (that is the entry's own point — under a
pipe, this IS Node's real behavior, not a divergence in the OBSERVABLE
sense corpus programs could ever exercise) — filed as a registered
scope statement per rule 2, matching board #66's own outstanding item,
not as a claim any pin exercises a difference. The 80-column caret
GATE's own VALUE is exercised (both directions) by
`packages/compiler/test/wasm-assert.test.ts`'s "F.2 assembler: the
caret's 80-unit boundary" pin (increment 23 P2b) and by
`wasm-assert-core.test.ts`'s own P1-era straddle; neither pin claims to
test the constant-vs-terminal-read distinction itself, only the
constant's own correct value.

## S060 — `url.fileURLToPathStr`'s file-scheme parser is narrower than Node's WHATWG parser on three axes: dot-segment resolution, percent-DECODED non-ASCII path bytes, and malformed percent-escapes — each traps by NAME rather than a silent wrong answer *(wasm tier — RETIRED by INC-29 U3)*

**Retired (INC-29 U3).** The file-scheme subset this entry describes is
gone: `fileURLToPath` — the string form and the URL form — now runs
through the WHATWG URL engine built in the module
(`packages/compiler/src/backend/wasm/url-whatwg.ts`, Node v24.18.1's ada
and `lib/internal/url.js`), which resolves dot segments, decodes
percent-escaped UTF-8 (a malformed sequence is decodeURIComponent's
`URIError`, as in Node) and parses every input Node's parser does. None of
the traps below exists any more; the divergence is closed, not moved.
What follows is the entry's history.

Increment 23 P3's rider 2 builds `url.fileURLToPath(str)`'s posix arm
(reference: `scr_url.c:344-709` — `scr_url_new` + `parse_rooted_path` +
`scr_url_to_path_impl`) narrower than both the C reference and Node's
own WHATWG parser on three axes, each a NAMED runtime trap (rule 1:
never a silently wrong path) rather than a ported behavior.

**Amendment (increment 23 P3 fix round F2-p3, rev-23's axis-D sweep,
finding F-1) — REAL gaps closed, not just documented; genuine scope-
boundary bugs fixed:** rev-23 found the parser silently returned a
WRONG path (not merely an incomplete one) on FOUR input classes, none
registered anywhere — and one of them is corpus-reachable TODAY: 1356
line 9 is `fileURLToPath('file:///tmp/%C3%A9')`, and the subject printed
`/tmp/Ã©` where Node prints `/tmp/café` (a byte-wise decode of café's
UTF-8 bytes — mojibake, not merely "not yet supported"). THREE of the
four classes are FIXED this round (query/fragment stripping, backslash
normalization; and, from a follow-up class-4 ruling that measured the
RAW half of the fourth class separately, raw non-ASCII code units too
— all no longer divergences, see below). Only the malformed-escape
class and the ENCODED half of the non-ASCII class remain this entry's
named traps, (b) and (c) below.

**FIXED this round (no longer divergences from Node — measured,
node v24.18.1):**
  - *Query and fragment stripping.* The path is truncated at the first
    UNESCAPED `?` or `#` before decoding — this IS Node's own pathname
    extraction, not a scope choice: `file:///tmp/x?q=1` -> `/tmp/x`;
    `file:///tmp/x#frag` -> `/tmp/x`. A percent-escaped `%3F`/`%23`
    stays literal (`file:///tmp/%3F` -> `/tmp/?`). The truncation cuts
    the WHOLE remainder — including what would otherwise be the
    AUTHORITY span — not just the path: `file://localhost?x/foo` ->
    `/` (the `?` is chopped before the host scan ever runs, so the
    host is exactly `localhost`, not a `localhost?x` mismatch); an
    empty-authority edge case round-trips too: `file://?x/tmp` -> `/`.
  - *Backslash as a path separator.* `file:` is a WHATWG SPECIAL
    scheme, where a raw `\` is a path separator exactly like `/` —
    everywhere a raw `/` is tested (slash-counting, authority-end
    scan, dot-segment split, rooting) and in the OUTPUT itself (Node
    never emits a literal `\` in a posix path): `file:///tmp/a\b` ->
    `/tmp/a/b`; `file:\tmp\x` -> `/tmp/x`; mixed/interleaved runs match
    too (`file:/\/tmp/x` -> `/tmp/x`; `file:\/\/tmp/x` -> `//tmp/x`).
    In SCHEME position (the count of leading `/`-or-`\` characters
    right after `file:`) the equivalence is LOUD, not invisible: it
    changes which slash-count bucket the parser lands in, so
    `file:\/tmp/x` and `file:\\tmp/x` (both exactly TWO leading
    delimiters, one or both a backslash) land in the 2-slash AUTHORITY
    form and THROW the ordinary File-URL-host `TypeError` (host
    `"tmp"`, not `"localhost"`/empty) — the same throw the all-forward-
    slash `file://tmp/x` already produces, not a new error shape. A
    percent-ESCAPED backslash (`%5C`/`%5c`) is a decoded BYTE, not this
    normalization's concern, and is untouched (`file:///tmp/a%5cb` ->
    `/tmp/a\b`, a literal backslash IN the output); the two mechanisms
    are provably independent, not just adjacent (`file:///tmp/a\b%5Cc`
    -> `/tmp/a/b\c` — ONE raw `\` normalizes to ONE `/`, the escaped
    `%5C` survives untouched right after it).
  - *Non-ASCII path bytes, THE RAW HALF* **(amendment, class-4 ruling,
    rev-23's fresh oracle measurements)**. This entry's ORIGINAL text
    (below) claimed a raw UTF-16 code unit `>= 0x80` anywhere in the
    path was a divergence needing a trap — measured fresh, this was
    ITSELF the divergence: Node's own parser percent-encodes-then-
    decodes a raw non-ASCII code unit LOSSLESSLY on the way through
    (`file:///t/é` -> `/t/é`; a REAL, paired astral character round-
    trips as its own intact surrogate pair: `file:///t/🌍` -> `/t/🌍`,
    `u16=[...,d83c,df0d]`; even a raw `U+0080` control byte passes
    through unencoded: `file:///t/` -> the same code unit back).
    The ONE exception is an UNPAIRED (lone) surrogate — Node's own
    WHATWG percent-encode step substitutes `U+FFFD` for it (measured:
    `file:///t/\uD800` -> `U+FFFD`, not the lone surrogate itself).
    Fixed by DROPPING the raw-code-unit trap entirely: every raw code
    unit copies through unchanged, EXCEPT an unpaired surrogate (either
    a high surrogate with no valid following low surrogate, or a low
    surrogate reached without one) substitutes `U+FFFD` — this needs no
    byte-level UTF-8 machinery at all, just the one surrogate-pairing
    check, since a raw code unit is already the UTF-16 value Node's own
    encode-then-decode round trip would produce.

**(a) Dot-segment resolution.** Node's own parser collapses `.`/`..`
path segments AT PARSE TIME (own measurement, node v24.18.1):

    file:///a/../b   -> /b
    file:///a/./b    -> /a/b
    file:///a/b/../../c -> /c
    file:///./a      -> /a
    file:///../a     -> /a
    file:///a/..     -> /
    file:///a/.      -> /a/

This tier's parser does NOT collapse them: a path containing a BARE
`.`/`..` segment (a `/`-delimited component matching exactly one or two
literal dots) throws a catchable `TypeError` naming the gap, rather
than returning the uncollapsed path (which would be a silently WRONG
answer, not merely an incomplete one — Node never observes the
uncollapsed form) or attempting to port `parse_rooted_path`'s own
segment-stack algorithm, which needs a genuinely different (stateful,
growable-stack) shape from this rider's otherwise single-pass byte
scan.

**Amendment (F-3) — the percent-encoded spellings now trap too.** This
entry's own heading always claimed "traps by NAME", but the trap's
FIRST implementation scanned RAW bytes only, so `%2e`/`%2E` (and their
combinations) passed straight through undetected and returned the
UNCOLLAPSED, percent-decoded segment — the heading was false of its
own body. Fixed by moving the check to run on the fully percent-DECODED
segment instead of the raw one (decoding is guaranteed to never produce
a `/` — that throws separately — so `/` stays the one and only segment
delimiter post-decode, and the identical exact-match-on-"."-or-".."
test applies unchanged). Measured: `file:///a/%2e%2e/b`, `file:///a/
.%2e/b`, `file:///a/%2e./b` now all throw, matching the pre-existing
raw `file:///a/../b` throw; `file:///a/%2eb/c` (Node: `/a/.b/c`) and
`file:///a/%2e%2e%2e/b` (Node: `/a/.../b`) do NOT throw — `.b` and
`...` are ordinary segments, not dot-segments, exactly like the
pre-existing `a..b` case.

**(b) Non-ASCII path bytes, THE ENCODED HALF ONLY.** Node's own parser
percent-decodes a `file:` path's percent-escapes as genuine UTF-8 bytes
on conversion — a decode-with-surrogate-emission step this tier's
parser does not implement. **The raw half of this same-looking
divergence is FIXED, not narrowed — see above; raw and encoded are
Node's own two DIFFERENT mechanisms (parse-time percent-ENCODE vs.
`fileURLToPath`'s own percent-DECODE) and this tier's fix tracks that
asymmetry exactly, rather than treating "non-ASCII" as one axis.** A
percent-DECODED byte `>= 0x80` traps: e.g. `file:///tmp/%C3%A9` decodes
to bytes that ARE valid UTF-8 for 'é' (this is 1356's own line 9,
byte-for-byte — `fileURLToPath("file:///tmp/%C3%A9")`), and
`file:///tmp/%F0%9F%8C%8D` decodes to a valid 4-byte astral sequence
(U+1F30D, 1611's own shape), but this tier traps rather than silently
emitting the raw decoded bytes (mojibake — the ORIGINAL F-1 bug:
`file:///tmp/%C3%A9` used to silently return `/tmp/Ã©`). A genuine
UTF-8 decoder with surrogate-pair emission was considered and
explicitly NOT built this round: neither 1356 nor 1611 is CLAIMED by
this rider either way — both refuse earlier, at `libCall:url.href`/
`libCall:process.cwd` respectively — so the choice between "byte-wise
trap" and "real UTF-8 decode" is invisible to the corpus census
regardless; the trap is the cheaper, lower-risk one to land correctly
in a bounded fix round — and, per the class-4 ruling, a decoder that
covered only VALID sequences would be worse than this trap: Node
throws `URIError: URI malformed` on every one of a measured set of
invalid encoded sequences too (a bad lead byte, a truncated multi-byte
sequence, an overlong encoding, an encoded surrogate, a bad
continuation byte, a stray continuation byte with no lead — see (c)),
so a future decoder MUST cover all of those under this SAME named trap
or it reintroduces F-1's own silent-garbage bug on exactly the inputs
this round closed. Real UTF-8 decoding (valid AND invalid sequences
both) remains open for a future rider. **This trap already SUBSUMES
those seven invalid classes today, with no extra code**: every one of
them necessarily contains at least one byte `>= 0x80` (pure ASCII
cannot form a malformed UTF-8 sequence), so the FIRST such byte trips
this trap before any actual sequence validation would ever run —
measured with a witness input, `file:///t/%C3%28` (`%C3` is a
well-formed hex escape decoding to a valid UTF-8 lead byte, but `%28`
is not a valid continuation byte for it — an INVALID sequence, not
merely an unsupported valid one; Node throws `URIError: URI malformed`
on it): this tier throws THIS trap (not the (c) malformed-escape one
below) the moment `%C3` alone decodes to `0xC3`, never inspecting `%28`
at all.

**(c) Malformed percent-escapes** *(new, F-1(4b))*. A `%` not
immediately followed by exactly two valid hex digits (a lone `%`, one
at the very end of the path, or followed by non-hex characters) used to
fall through and copy the literal `%` character through unchanged.
Node throws a catchable `URIError: URI malformed` for EVERY case
measured: `file:///tmp/a%zzb`, `file:///tmp/a%` (trailing), `file:///
tmp/a%2` (truncated) — no exception. This tier has no `URIError` class
(`RUNTIME_ERROR_CLASSES`: `%Error`/`%TypeError`/`%RangeError`/
`%SyntaxError`/`%DOMException` only — adding a fifth runtime error
class is not cheap in a bounded fix round) so it throws a catchable
`TypeError` naming the gap instead, same style/class as (a) and (b).

**Forward pointer (INC-25 P5, board #129):** the tier now DOES throw a
real, catchable `URIError` — `instanceof Error`, `.name === "URIError"`
— for `str.encodeUri`/`str.encodeUriComponent`/`str.decodeUriComponent`
(`packages/compiler/src/backend/wasm/uri.ts`), via the SAME name-
independent-of-class mechanism this entry's own (c) could reuse
(`emitSetCellError`/`emitSetCellErrorLit`, no sixth `RUNTIME_ERROR_
CLASSES` entry). This paragraph is phrased historically and is not
itself stale — (c)'s own choice to throw a catchable `TypeError` for
`fileURLToPathStr`'s malformed-escape trap is unchanged — but a reader
following the "no URIError class" reasoning here should find uri.ts,
not conclude a real URIError is out of reach tier-wide.

**Rationale:** the two remaining gaps ((b)'s encoded half and (c)) are
SCOPE narrowings of a rider whose own contract claims exactly one
corpus program (2385, ASCII paths, no dot segments, well-formed
escapes) — rule 1 (out-of-tier constructs refuse loudly, never
silently miscompile) applied to a parser subset, the same discipline
S016/S029/S057's own "we deliberately did not build the general case"
entries already establish for other constructs this tier. Neither is
reachable by 2385's own claim; 1356/1611 (the two OTHER corpus
programs that reach `url.fileURLToPathStr` as their own first blocker)
exercise the ENCODED-non-ASCII and malformed-input classes (1356's own
line 9, 1611's astral case), but neither program is claimed by this
rider (both advance to a DIFFERENT, unrelated `url.*`/`process.*`
construct as their own next refusal — `libCall:url.href`/`libCall:
process.cwd` respectively — confirmed empirically in P3's own freeze,
again unchanged in F2-p3's own re-run census, and a third time in the
class-4 follow-up round via a standalone `compile()` call on both real
corpus files). The dot-segment gap (a) is a genuinely incomplete
algorithm (Node's collapsing needs a growable segment stack this
rider's single-pass scan does not have), not a corpus-input-alphabet
gap like (b)/(c) — it is listed here for the same "trap by name, never
silent" discipline, not the same root cause.

**Tested by:** `packages/compiler/test/wasm-url.test.ts` — the dot-
segment trap (bare `.`/`..`, both raw and the F-3 percent-encoded
spellings, plus the non-dot-segment near-misses that must NOT trap),
the F-1(4) percent-decoded non-ASCII trap (including 1356's and 1611's
own literal inputs), the F-1(4b) malformed-escape trap, and the
F-1(1)/(2)/(3)-plus-class-4-raw-non-ASCII fixes (now plain byte-exact-
vs-Node pins, not divergence pins — including the surrogate-pair and
lone-surrogate-to-U+FFFD cases) — all confirmed `instanceof TypeError`
where applicable with the exact message text above; every OTHER corner
case this rider DOES claim (localhost, `%20` decode, `%2F` rejection, the
0/1/2/3-slash host-less forms, the "Invalid URL"/"must be of scheme
file"/host-rejection messages, the scheme case-fold) is pinned
byte-exact against a live Node v24.18.1 measurement in the same file,
and confirmed via the wasm-differential corpus (2385 claims; 1356/1611
advance to their predicted next refusal, not this one; census table
unchanged by this fix round — nothing here is reachable before
`url.href`/`process.cwd` clear).

## S061 — `Object.defineProperties`: an accessor (`get`/`set`) descriptor throws a loud Error, on BOTH lanes *(inherited)*

Node accepts a `get`/`set` descriptor on any target (MEASURED: `Object.
defineProperties(o, {x: {get: () => 42, enumerable: true}})` then `o.x`
answers 42, `Object.keys(o)` answers `["x"]` — an ordinary accessor
property, indistinguishable from a hand-written one). Following that
would mean modelling accessor properties in the dyn tree — a getter
that runs on every read, a setter on every write, threaded through
`keyGet`/`keySet`/`objWalk`/every inspect renderer — a build far larger
than the rest of this feature combined, for a shape no claimed corpus
program uses. Both lanes refuse it instead, by name, as a plain
(non-Type) `Error`: `"accessor (get/set) property descriptors on a
dynamic value are not supported yet"`. The wasm lane's wording is the C
runtime's own (`scr_dyn_define_props`, `SCR_ERR_ERROR`), ported
verbatim rather than independently chosen — an inherited divergence,
not a wasm-tier one. `get`/`set` PRESENCE is the trigger, not validity:
`{get: 1}` throws exactly the same way `{get: () => 42}` does, even
though Node itself would separately reject `{get: 1}` for a different
reason ("Getter must be a function") — this tier's own check runs
before any such distinction would matter, and no corpus program probes
the difference.

**Rationale:** a deliberate, permanent scope boundary rather than an
oversight — see board #98's own H-3 ruling. The two members every
function already carries (`name`, `length`, S020) and the plain-value
members `Object.defineProperties` (SEMANTICS.md S016's amendment,
increment 23 P4) actually stores are unaffected; only a descriptor that
carries `get` or `set` at all is rejected. **Tested by:**
`packages/compiler/test/wasm-dyn-defineprops.test.ts` — the accessor
descriptor pin (both a callable and a non-callable `get`/`set` value,
both an OBJ and a FUNC target), confirmed as `instanceof Error` and NOT
`instanceof TypeError`, with the message text byte-exact; no corpus
program can pin this directly (claim 0 — every consumer's descriptors
are plain `value`/`enumerable` pairs).

## S062 — `Object.defineProperties`: a non-enumerable property on an OBJ target refuses by name *(wasm tier)*

Node gives a plain object a genuine non-enumerable own property
(MEASURED: `Object.defineProperties(o, {x: {value: 1, enumerable:
false}})` then `o.x` answers 1, `Object.hasOwn(o, "x")` answers true,
`Object.keys(o)` answers `[]`, and `Object.getOwnPropertyDescriptor(o,
"x")` shows the full descriptor). A dyn OBJ node has no hidden plane —
its own-entry table (S016) is the ONLY storage a member can occupy, and
every entry in it enumerates. Routing a hidden OBJ property through the
SAME side table `Object.defineProperties` gives boxed FUNCTIONS
(SITE A, keyed on `FN_CLOS`) was considered and rejected: an OBJ box
COPIES across the `unknown` boundary (S014), while the side table would
not follow the copy, silently dropping the hidden property on the far
side — a WORSE, silent divergence traded for a louder one. The wasm
lane refuses instead, by name, at the `Object.defineProperties` call
itself: a plain (non-Type) `Error`, `"Object.defineProperties: a
non-enumerable property descriptor on a plain-object dynamic value is
not supported yet"`. This is a WASM-TIER divergence, not an inherited
one — the C lane takes the THIRD option Node itself does not (store the
property visibly regardless of the flag, S016's amendment's own "C lane
still... accepted and ignored" note), so C and wasm disagree with each
other here as well as with Node, in two different directions.

**Rationale:** loud beats silent, and the corpus never reaches this —
every one of the 1700/1701/1703 consumers this board exists for targets
a FUNCTION, never a plain object, with `Object.defineProperties`; board
#98's own H-1 ruling records the three options considered and why this
one was chosen. Should a program ever need a genuinely non-enumerable
OBJ member, the fix is a second OBJ storage plane (S016's own
Rationale: "a feature, not a fix"), not a special case here.
**Tested by:** `packages/compiler/test/wasm-dyn-defineprops.test.ts` —
the OBJ-target `enumerable:false` refusal pin (confirmed `instanceof
Error`, not `TypeError`, message byte-exact) beside its OWN positive
control (`enumerable:true` on an OBJ target succeeds and reads back,
proving the refusal is keyed on the flag and not the target kind); no
corpus program can pin this directly (claim 0, the same reason S061
gives).

## S063 — assert's error-identification messages (`assert.throws`'s class-mismatch text, `assert.ifError`'s empty-message fallback) substitute the error's stored `name` SLOT for Node's `constructor.name`, so a CUSTOM subclass without its own `this.name` override reports its BASE class, not its true derived class *(inherited)*

`e.constructor.name` cannot be written at all on this tier —
`Function.name` (reading `.name` off a function/constructor value) "has
no scriptc lowering yet" (SC2020, identical refusal on every backend
including native), so no corpus program can even ATTEMPT the literal
construct this entry is about. The observable surface is narrower:
Node's own `assert.throws(fn, ErrorClass)` mismatch text ("...Received
\"<name>\"") and `assert.ifError(err)`'s empty-message fallback both
read `err.constructor.name` — this runtime instead answers whatever
`err`'s own `name` SLOT holds (`scr_assert.c`'s own comment: "this
runtime carries the `name` slot"). For every BUILT-IN error kind
(`Error`, `TypeError`, `RangeError`, …, and any subclass of one that
never overrides `name` itself, e.g. `class EmptyTypeError extends
TypeError {}`) the two answers coincide, because Node pre-seeds
`TypeError.prototype.name = "TypeError"` etc. at the class level, so the
slot this runtime tracks already holds the right per-kind string. For a
CUSTOM subclass of `Error` (`class Weird extends Error {}`) that never
sets `this.name` itself, Node's real `constructor.name` is the truly
derived class ("Weird", or "WeirdDeep" three levels down a subclass
chain) while `.name` is the INHERITED `Error.prototype.name` ("Error")
— this runtime has no per-class name slot for user-defined subclasses,
so it answers the base "Error" (or "TypeError" for a user subclass of a
built-in) regardless of how deep the chain runs.

MEASURED, all four fixtures (`class Weird extends Error {}`, `new
Weird()` [empty message] and `new Weird("boom")` [with message], `class
WeirdDeep extends Weird {}`, `new TypeError("bad type")` as the
built-in control), on all reachable lanes:

- **Node (oracle):** `assert.throws` mismatch answers "Weird" /
  "Weird" / "WeirdDeep" / "TypeError" respectively; `assert.ifError`'s
  empty-message fallback (only reached when the error's OWN `.message`
  is empty — the with-message and built-in-with-message fixtures report
  their message text instead, unrelated to this entry) answers "Weird"
  for the bare `new Weird()` and "EmptyTypeError" for a bare `class
  EmptyTypeError extends TypeError {}` instance.
- **C, LLVM (identical to each other, byte-exact, native = "the output
  that ships" — `scriptc run --backend c` / `--backend llvm` on the
  identical source):** `assert.throws` mismatch answers "Error" /
  "Error" / "Error" / "TypeError"; `assert.ifError`'s empty-message
  fallback answers "Error" for `new Weird()` and "TypeError" for the
  bare `EmptyTypeError` instance — the derived name is LOST for every
  custom subclass, RETAINED for every built-in one.
- **wasm:** `assert.throws`'s class-constructor form IS wasm-reachable
  and witnesses this divergence DIRECTLY — `class Weird extends Error
  {} assert.throws(() => { throw new Weird("boom"); }, RangeError)`
  builds and runs, answering `The error is expected to be an instance
  of "RangeError". Received "Error"` (message trailer: `Error message:
  boom`); Node answers the SAME program `Received "Weird"` instead.
  (CORRECTION, this round: an earlier draft of this entry claimed the
  identical shape "refuses to build" — WRONG, confirmed by direct
  reproduction; the refusal that misled the original probe was an
  UNRELATED construct — an `unknown`-typed caught value passed as an
  ARGUMENT into a separate helper function that narrows it via
  `instanceof` INSIDE the callee, nothing to do with `assert.throws`,
  custom subclasses, or this entry's own mechanism — isolated by
  removing exactly that one element while holding everything else
  fixed, confirmed both ways.) `assert.ifError`'s own empty-message
  fallback answers "Error" for `new Weird()` and "TypeError" for the
  bare `EmptyTypeError` instance — IDENTICAL to C/LLVM on BOTH assert
  surfaces, confirming the divergence is the SAME one mechanism across
  the whole backend family and reachable through either entry point,
  not a wasm-specific narrowing or widening of it.

THE FOUR FIXTURES ABOVE NEVER ASSIGN `.name` — every one leaves the
slot holding its INHERITED value, so on their own they cannot separate
this entry's own claim ("assert reads the `name` SLOT") from a WEAKER
story ("assert reports the base CLASS name"), which predicts the
identical "Error" answer for every one of them. This is narrower than
it sounds: the mechanism itself already has authorial testimony —
`scr_assert.c`'s own comment ("this runtime carries the `name` slot")
predates this entry and is UNCHANGED by it, only its citation moved
(§ above) — so the gap is that S063's OWN FOUR FIXTURES never
WITNESSED S063's OWN claim, not that the claim was in doubt. Three
further fixtures close exactly that witnessing gap — `class Weird
extends Error {}`, then an EXPLICIT post-construction `.name`
assignment before the same `assert.ifError` empty-message-fallback
path, MEASURED on Node + C + LLVM + wasm:

- **`.name = "NotWeird"`, message PRESENT** (`new Weird("boom")`):
  Node and every lane alike answer "boom" — a present message always
  wins over the fallback, unrelated to the `.name` axis; included only
  to confirm the override does not accidentally disturb that ordering.
- **`.name = "NotWeird"`, EMPTY message:** Node still answers "Weird"
  — `constructor.name` is a class-level property, entirely unaffected
  by an instance-level `.name` assignment. C, LLVM, and wasm
  (byte-identical to each other) answer "NotWeird" — the OVERRIDDEN
  slot value, verbatim.
- **`.name = ""`, EMPTY message:** Node still answers "Weird". C,
  LLVM, and wasm answer the EMPTY STRING, verbatim — the case that
  actually decides the question: a base-class-name fallback CANNOT
  answer "" (there is no class named ""), so only a raw, unconditional
  read of the `name` slot explains this result. This entry's own
  mechanism claim is now WITNESSED by its own fixtures, not merely
  attested by the C source's comment; the weaker "reports the base
  class" story is FALSIFIED by this one case.

**Rationale:** general `constructor.name` reflection is unbuilt tier-
wide (the `Function.name` SC2020 refusal above) — modeling it fully
would mean tracking a per-INSTANCE (or per-prototype-chain) runtime
identity distinct from the `name` slot assert already carries for
every error value, for a construct with no other tier-wide reachability
today. The `name`-slot substitution is the smaller, already-necessary
mechanism (assert needs SOME string for its message regardless) that
happens to agree with Node exactly on the reachable built-in hierarchy
and diverges only on the class of program this tier does not yet let
users observe `constructor.name` on directly. C and LLVM share one
runtime (`scr_assert.c`) and so trivially agree; wasm's OWN, separately
built assert machinery was MEASURED to answer identically rather than
assumed to (the probes above), which is why this entry is *(inherited)*
— the same observable behavior across the whole backend family — rather
than a per-lane split; this filing does not claim the wasm and C/LLVM
implementations share code, only that they agree on this output.

**Tested by:** the filing-day probes (`ctorname-probe3.ts` through
`ctorname-probe6.ts`, the discriminating-fixture probe
`s063-discrim2.ts`, and the throws-surface reproduction/isolation
probes, all run directly via `scriptc run --backend c`/`--backend
llvm` and via the wasm compile+host harness) — no corpus program
reaches this today (grep-confirmed: the corpus's one custom-subclass-
plus-`assert.throws`/`assert.ifError` file,
`1721-assert-throws-regex-class.ts`'s `AppError`, only appears in a
bare-pass and a no-throw "missing exception" scenario, neither of which
routes through the mismatch/ifError constructor-name text this entry
describes) — claim 0, the same reason S061/S062 give. TWO PINS are
landed in `wasm-assert-core.test.ts`, beside the existing `ifErrorDyn`
composite-kind trap tests, using the file's own established
`build()`/`runWasm()`/`MESSAGE_OF_HELPER` patterns: the `assert.
ifError` empty-message-fallback pin (a custom `class Weird extends
Error {}`, empty-message instance, "Error" answer byte-exact) and the
`assert.throws` class-mismatch pin (the same `Weird` class thrown
against a `RangeError` expectation, `Received "Error"` answer
byte-exact) — each stating BOTH the current wasm answer and, in its own
comment, Node's differing answer for the identical program, so each is
demonstrably a divergence guard rather than a tautology.

## S064 — a NONPARTICIPATING capture reads "" where Node holds `undefined` *(wasm tier; native lanes ship the same divergence)*

A capture group that did not participate in the match reads as the
empty string in every result this tier produces — `match`'s slice,
`matchAll`'s rows, the `.groups` projection, and `split()`'s spliced
slots (S066) — where Node's slot holds `undefined`. This is
UNAVOIDABLE, not a design choice with an alternative: the IR types
these results `string[]` (`ir/validate.ts:55-76`), which has no
representable absent element, and widening it to `(string |
undefined)[]` would poison every consumer of every regex result in the
language. Only an IR change could fix it, and that is out of scope —
there is no board to track, because there is no fix to track.

It COLLAPSES a distinction Node really makes: `/(a*)*/.exec("b")` is
`["", null]` in Node and `/(a*)+/.exec("b")` is `["", ""]`; on this
tier both render `["", ""]`. Corpus programs stay comparable by
guarding the slot (`2608` uses `opt.tail ? opt.tail : "(none)"`,
`1544` uses `?? ""`), which works because `""` and `undefined` are
both falsy.

**Rationale:** forced by the IR result contract (`string[]`, no
absent-element representation); shared with the native lanes, which
carry the identical limitation for the identical reason — all three
lanes render `""`, only Node holds `undefined`.

**Tested by:** `1544` and `2608` (the guarded spellings, which stay
byte-exact because both empty and undefined satisfy the guard); the
wasm emitter unit test pins the UNGUARDED slot directly, since no
corpus program can pin it — the differential would fail by
construction on the unguarded shape, S003's "cannot be differential-
tested" case.

**Amendment (board #301): function replacers are Node-exact; two
readers keep this entry's "".** A FUNCTION replacer (`s.replace(re, fn)` /
`replaceAll`) receives Node's `undefined` for a capture that did not
participate whenever its parameter can hold it: a parameter LEFT
UNANNOTATED (TypeScript types it `any`) is bound by the replacer's
lowering to `string` when the capture always participates in a match —
no alternation, zero-admitting quantifier or lookaround around it
(`(_, c) => c.toUpperCase()` over `/-(\w)/`) — and to `string | undefined`
otherwise (`(m, a, b) => b ?? "dflt"` over `/(a)(z)?/` answers Node's
`dfltb`); a parameter annotated `string | undefined` or optional
(`p?: string`) gets the same exact value, and a parameter past Node's
arguments is `undefined`. A groups parameter annotated
`{ [name: string]: string | undefined }` holds `undefined` for a group
that did not participate (an unannotated one refuses by name — annotate
it). What still reads "": a capture parameter the program ANNOTATES as
plain `string` (its own claim that the capture is a string — this entry's
stance; Node passes undefined there), a groups parameter annotated with
`string` values, and an exec/match result's `.groups` read through its
hidden companions (lower-regex.ts), the same projection as before. A
replacer that reads `arguments` refuses by name (Node passes match,
captures, offset, input and groups; the call through the replacer's own
signature cannot). **Tested by:** corpus 2796 (the unannotated,
`string | undefined`, optional and groups spellings, Node-exact) and the
regex state fuzz (`string | undefined` captures).

## S065 — an invalid pattern: a regex literal refuses at compile time and `new RegExp` throws Node's catchable `SyntaxError` with V8's text *(every lane since follow-up unit D, below; the NATIVE lanes used to abort at first use)*

Two axes, one entry (S055 is the precedent for a single entry carrying
both): WHEN the failure is reported, and WHAT TEXT the thrown error
carries.

TIMING, three arms by how the pattern reaches the compiler. A bad
LITERAL such as `/(/`: Node is a parse error (MEASURED — not one
module statement runs, no program output at all); wasm is a compile-
time diagnostic (no binary, so likewise no program output) — MEASURED
(INC-24 P3, gate finding F1) to be TSC's OWN preflight passthrough
(`SC0001`), common to every backend, not this tier's own regex
machinery: TSC's regex-literal handling does real ECMAScript-grammar
validation at parse time (confirmed against bracket-BALANCED invalid
patterns like `a{2,1}`, which a shallow lexer bracket-check would not
catch, and TSC still rejects), so an invalid literal never reaches the
wasm backend's own `expr:regexLit:invalid-pattern` check at all. That
check still exists and still fires correctly when reached (a hand-
built IR fixture proves it, bypassing TSC's own lexer — packages/
compiler/test/wasm-emitter.test.ts) — it is a BACKSTOP against TSC's
own validation specifically (a third-party dependency this project
does not control and that changes across versions; a future TSC
version accepting something design-regex-v6.txt §5.1 doesn't handle
would otherwise flow a bad literal into parse/assemble undefined, the
silent-wrong class this project refuses to risk), not the mechanism
that fires in today's actual toolchain. The observable claim below is
unchanged either way — no binary, no program output, same as Node's
own parse-error behavior — only WHICH gate produces it is corrected
here. The NATIVE lanes are the ones that diverge, and diverge loudly
in the worst way — the program STARTS, runs, produces output, and
THEN aborts uncatchably at first use of the regex (`ir/nodes.ts:4177-
4186`). wasm and Node agree on the only thing that matters
observably (zero output); only WHERE the failure is reported differs,
which is the refusal contract, not a behavioral divergence. A bad
COMPILE-TIME-CONSTANT argument such as `new RegExp('(')`: Node throws
a CATCHABLE runtime `SyntaxError` at the construction point; wasm
does the same — the compiler knows the pattern is invalid and knows
V8's message, so it emits a THROW of that exact `SyntaxError` there, a
constant-folded throw rather than a runtime parser (`2284`'s
`assert.throws(() => new RegExp('('), SyntaxError)` depends on this
catchable behavior and is the witness — refusing here, the natural
reflex for an invalid construct, would fail `2284`); native aborts
uncatchably at first use, same as the literal arm. A NON-CONSTANT
argument refuses by name (`libCall:regex.new:dynamic-pattern` /
`:dynamic-flags`) — a refusal, not itself a divergence.

MESSAGE TEXT, the second arm. `ir/nodes.ts` documents `regex.new`'s
NATIVE error as "Node's message shape with libregexp's detail text
(APPROXIMATE FIDELITY; `e.name` exact)". Node's own text: e.g.
`"Invalid regular expression: /(/: Unterminated group"`. wasm emits
the SAME string exactly — the compiler knows the pattern at compile
time, so the message is a CONSTANT, with no runtime parser to
approximate it with (compiling early makes this tier MORE exact than
the reference it was ported from, not less). native carries
libregexp's own detail text in Node's message shape — approximate,
not exact. REACH: latent — no corpus program distinguishes the two;
`2284`'s `assert.throws` asserts the error CLASS only and never reads
the message, so this axis is recorded here rather than caught by a
test.

**P5's actual coverage of this arm (added INC-24 P5 — this claim is
narrower than "the SAME string exactly" reads unqualified):**
design-regex-v6.txt §5.5(B)'s own message table names nine distinct
INVALID-PATTERN reasons; P5 built exact-message coverage for the
THREE a structural balanced-bracket/character-class scan can decide
with certainty (Unterminated group / Unmatched ')' / Unterminated
character class) plus invalid-flags (fully general — the message is
just the flags string echoed back, no reason-classification needed).
The other six (a bad quantifier range, a duplicate capture group name,
an unresolvable `\p{}` property, an invalid named-capture reference,
and the rest of the table) are NOT approximated and are NOT guessed —
they refuse by name (`libCall:regex.new:unclassified-syntax-error`),
this project's standing "never guess" rule, same as a non-constant
argument refusing rather than miscompiling. This is still Node-safe on
every reachable path (a refusal is never itself a divergence, per this
entry's own TIMING arm above) — the gap is only that "wasm emits the
SAME string exactly" should be read as "for every reason it has exact-
message coverage for," not as a claim that the tier fully implements
design-regex-v6.txt §5.5(B)'s whole table yet. No claim in P5's own
set (1634/2367/2608; 2284 needs only Unterminated group and invalid-
flags, both covered) reaches the six-reason gap. A future increment
closing it needs no new S-entry, only removing this note.

**Rationale:** wasm compiles the pattern at compile time and so KNOWS
both the SyntaxError-vs-abort question and V8's exact message text up
front, letting it reproduce Node byte-exactly on both axes as a
constant; the native lanes parse at runtime with no compile-time
knowledge of the pattern's validity, so they abort rather than throw
catchably, and approximate rather than reproduce the message.

**Tested by:** the literal arm's own backstop (`expr:regexLit:invalid-
pattern`, both mint sites) is proven live by two hand-built IrModule
fixtures (INC-24 P3 gate finding F1) that bypass TSC's own lexer
entirely — the ONLY way to reach it, since TSC's preflight gate makes
it structurally unreachable through real source (above). `2284`
(`assert.throws(() => new RegExp('('),
SyntaxError)`) is the corpus witness for the TIMING/catchability axis
only; the message-text axis is corpus-unpinnable (latent, per REACH
above) and is recorded here as the measurement of record rather than
guarded by a test.

**Amendment (unit P1): the run-time arm.** A NON-CONSTANT argument no
longer refuses (`libCall:regex.new:dynamic-pattern` / `:dynamic-flags`
are retired): the wasm tier compiles the pattern when the program runs
(`regex-compiler.ts`, `%w.rec.compile`) and builds the same value the
constant arm embeds — the same bytecode, held equal by
`packages/compiler/test/wasm-regex-runtime-compiler.test.ts`. An invalid
run-time pattern or flags string (one holding both `u` and `v` included,
before the /v fence) throws Node's catchable `SyntaxError`
at the construction point with V8's exact message (the RAW pattern, the
CANONICAL flags — `new RegExp("(", "ig")` reports `/(/gi`, at build
time too, which this unit corrected), wherever that gate measured V8
agreeing on the reason and on which error is reported first; a pattern
outside the tier throws the named Error of S102. A constant pattern
whose syntax error the build-time pipeline cannot word (the old
`libCall:regex.new:unclassified-syntax-error`) now goes through the
run-time compiler too and throws V8's text. Native lanes unchanged.

**Amendment (unit E): one compiler.** The build-time TypeScript pipeline
(parser, assembler, disposition layer, syntax-reason classifier) is
gone. A regex literal, the sticky clone a literal `.split()` receiver
needs, and a `new RegExp` whose texts fold are compiled by RUNNING the
run-time compiler at build time (`regex-buildtime.ts` instantiates it in
the compiler's own process), so every constant pattern embeds exactly
what the same texts would build at run time. Consequences, all toward
Node: (1) a folded constant's SyntaxError is V8's text for every reason
(the "P5's actual coverage" note above is retired), which also fixes a
silent divergence — the old classifier worded many constant syntax
errors wrongly (`new RegExp("(?<a")` threw "Unterminated group" where
Node says "Invalid capture group name"; 3,352 rows of the 31,114-row
gate pool); (2) a `\p{…}` whose name is malformed in a way V8 decides
without its property tables — `\p{`, an empty name or value (`\p{}`,
`\p{L=}`, `\p{sc=}`), a `Name=Value` whose name is not General_Category
/ gc / Script / sc / Script_Extensions / scx, a General_Category value
that is not one, or one of those six names standing alone — throws V8's
SyntaxError instead of refusing as `unported-unicode-property` (a name
only the tables can judge — `\p{Foo}`, `\p{sc=Foo}`, a binary property —
stays that fence, S102); (3) a regex LITERAL Node rejects (#264: a
duplicate group name V8 rejects, `\k` inside a class with named groups)
refuses as `expr:regexLit:invalid-pattern` instead of building; (4) a
constant the old pipeline handed to the run-time compiler (an
unclassified syntax error, a V8-only rejection, an /iu syntax check) is
folded at build time — its SyntaxError a constant throw, its value
embedded — so the module no longer carries the run-time compiler for
it; (5) a constant `new RegExp` whose texts are outside the tier is NOT
a build refusal (review M2, lead ruling): the call throws S102's named
fence Error (message and `code` exactly the run-time compiler's), as the
constants the old pipeline deferred to run time always did — a constant
`new RegExp` on a path that never runs costs the program nothing. Five
shapes the old pipeline refused at build time (`libCall:regex.new:`
`modifiers`, `unicode-casefold`, `annexb-*`, `unicode-sets-flag`,
`unported-unicode-property`) now build and throw at the call the same
way. A regex LITERAL outside the tier still refuses at build time. If
the host cannot run the build-time compiler (it needs WasmGC: Node 22 or
later), a constant pattern refuses by name
(`expr:regexLit:build-time-compiler-unavailable` /
`libCall:regex.new:build-time-compiler-unavailable`). Measured over the
31,114-row gate pool against the retired pipeline: every changed outcome
is toward Node's, or a refusal whose key moved — 9 /iu patterns holding a
`(?i:)` group fence as `unicode-casefold` (the documented precedence,
which the literal path always had) where the old `new RegExp` path said
`modifiers` through a caught internal assertion; a literal's key moves
only where Node rejects the pattern (now `invalid-pattern`) or accepts
one the old parser could not (now the Annex-B family that names it). The
old literal path also threw out of the compiler on 55 pool rows holding
a modifier group that turns /i on under /u (`/(?i:a)/u`); they now refuse
as `modifiers`, or `invalid-pattern` where Node rejects them.

**Board #117** tracks the native fix: make the native lanes throw a
catchable `SyntaxError` at construction rather than aborting at first
use, bring their message text to V8's, and rewrite the doc comment at
`ir/nodes.ts:4177-4185` (the repoint itself is a P1 deliverable — the
comment goes false when the WASM behavior lands, not when board #117
does).

**Amendment (follow-up unit D): every lane, one compiler.** The native
lanes no longer compile with libregexp. They run the wasm tier's own
regex engine — the module regex-engine-module.ts builds (the one
compiler, the matcher, the regex value), translated to C by
`backend/wasm2c.ts` into `packages/runtime/src/scr_regex_engine.h`
(generated; `native-regex-engine-drift.test.ts` holds it equal to a
fresh translation) — so this entry's native arms are retired and its
wasm arms are every lane's: (1) a regex LITERAL is compiled at build time
by the same compiler on every lane, and one it refuses refuses the native
build too, by the same key (`expr:regexLit:<key>`, SC3001 — a pattern
Node rejects is `invalid-pattern`; a native program no longer starts and
aborts at the regex's first use); (2) `new RegExp` throws V8's catchable
`SyntaxError` with V8's exact text on every lane (the native lanes
compile a constant pattern at run time where the wasm tier folds it at
build time — the same outcome at the same point of the program); the
"approximate fidelity" message arm is gone. A native literal is still
compiled lazily at its first use (the build-time verdict already said it
compiles); its `.flags` are the build-time compiler's canonical ones
(S067). Measured: the regex gate's pool through one program on wasm, c
and llvm (`packages/compiler/test/native-regex-lanes.test.ts` — 30,711
rows, the 403 holding a lone surrogate left out because the native
lanes' strings cannot carry one) prints the same bytes on all three,
equal to Node's on every row but S102's fenced ones; and the translation
equals the module it came from over the whole pool and 395,402 exec
rows (`native-regex-engine.test.ts`), plain and under ASan + UBSan.
Board #117 is closed by this unit.

## S066 — `split()` with capture groups: the WASM tier SPLICES as Node does; the NATIVE lanes throw a `TypeError` *(per-lane split until board #301: every lane splices now — see its amendment)*

On `"a1b".split(/(\d)/)`: Node answers `["a","1","b"]`; wasm answers
the same, `["a","1","b"]` (Node-exact); the native lanes throw
`Uncaught TypeError: split() with capture groups in the pattern is not
supported (JS splices the captured values into the result); use a
non-capturing group (?:...)`, then exit 1 (`evidence/splitcap-t.ts`).
The entry exists even though the wasm tier conforms, because the
lanes cannot be silently aligned: a reader comparing lanes must see
that one splices and one throws — S044's own reason for existing. The
splice fits the IR's `string[]` result contract: the capture count is
compile-time known and every spliced element is a string, except
NONPARTICIPATING slots, which are `undefined` in Node and ride S064's
`""` rendering here.

**Rationale:** the wasm tier's compile-time knowledge of the pattern's
capture structure makes an exact splice straightforward; the native
lanes' `split()` predates capture-splicing support and refuses rather
than risk a wrong splice — matching S044's own aliasing precedent
(the more capable side conforms, the less capable side keeps its
existing, honest refusal rather than a masked approximation).

**Tested by:** `evidence/splitcap-t.ts` is the native-lane witness;
the wasm tier's own splice shapes are measured in the P3 build that
lands it (§7.3), against `1544`-family corpus programs using
`split()` with capturing patterns.

**Board #118** (NATIVE SIDE ONLY) tracks making the native lanes
splice; the native lanes' `string[]` result has the same
representability limit S064 already names, so #118's fix inherits
S064 rather than needing anything new. THE COMMENT REPOINT IS NOT ON
THIS BOARD — it is a P3 deliverable: `ir/nodes.ts:1634` (inside doc-
comment block `1627-1637`) states the throw as an ALL-LANE contract,
and it goes false the moment the WASM tier splices in P3, whether or
not board #118 ever lands, so the repoint is tied to P3's own landing
rather than to the native fix's timing.

**Amendment (board #301): every lane splices — the per-lane split is
over.** The native lanes' `split()` now splices capture values into the
result like the wasm tier (nonparticipating slots "" per S064), so the
TypeError arm above is retired and board #118 is closed. Both sides run
the same algorithm (`backend/wasm/regex-state.ts`'s split, `scr_regex.c`'s
`scr_regex_split_core`): Symbol.split with the limit argument (ToUint32;
`split(re, limit)` lowers on every lane now), and the regex's own
lastIndex untouched; a regex held in a VARIABLE splits on the wasm tier
too (it used to refuse as `expr:regexIntrinsic:split`). The split POINTS
follow V8's two paths, which differ under /u: its fast path SEARCHES from
q with the regex itself (a match the search finds AT the end is no split
point — the spec probes only q < size), stepping by code unit, so a
zero-width match between the halves of a surrogate pair splits there
(#269); its slow (spec) path probes per position, stepping whole code
points, and never splits inside a pair. V8 takes the slow path when the
regex is sticky, when the limit is present and not a non-negative Smi,
or when lastIndex is not a non-negative Smi — every lane decides the same
way BY VALUE: an integer in [0, 2^31-1] that is not -0 counts as a Smi
(`"😀a😀".split(/\B/u)` → 2 pieces; with `lastIndex = -1`, or a limit of
2^31, → 1, as in Node). THE RESIDUAL: V8 decides by REPRESENTATION, and
holds some integer-valued numbers as heap numbers — one read from an
array that also holds a non-integer, or produced by floating-point
arithmetic — which send it down the slow path where this tier, seeing an
integer, takes the fast one. Only a /u split with a zero-width match
inside a surrogate pair can tell the paths apart. **Tested by:** corpus
2795 (limits, capture splicing, `/$/`, the /u path pairs above) and the
regex state fuzz, on all three lanes.

## S067 — `.flags`: the WASM tier renders Node's CANONICAL order; the NATIVE lanes render SOURCE order *(per-lane split until follow-up unit D: every lane renders canonical order now — the native arm is retired, see the unit D note below)*

`RegExp.prototype.flags` reads the flag getters in a fixed order, so
Node answers `"gimsuy"` for a regex written `/b/yusmig`. MEASURED on
five literals (`evidence/flagorder-t.ts`) — all five differ between
Node and the native lanes:

| literal      | Node   | wasm (designed) | native (today) |
|--------------|--------|------------------|-----------------|
| `/b/yusmig`  | gimsuy | gimsuy           | yusmig          |
| `/x/mig`     | gim    | gim              | mig             |
| `/y/us`      | su     | su               | us              |
| `/z/ym`      | my     | my               | ym              |
| `/q/sg`      | gs     | gs               | sg              |

The native lanes return `scr_regex_flags`' stored SOURCE-order string.
The wasm tier sorts into canonical order at compile time (design §3.2,
§5.6 — roughly five lines), strictly Node-exact. This also governs
`assert.match`'s message rendering and `util.inspect` of a regex, both
of which render `/source/flags`.

REACH OF THE NATIVE BUG: latent, not live. Scanning all 1077 corpus
programs, all 10 multi-flag literals are already written in canonical
order, so no corpus program can currently catch it — that is why
board #119 is a fix board and not a failing test.

**Rationale:** the wasm tier's compile-time flag-string construction
makes canonical ordering a five-line sort with no cost; the native
lanes store the SOURCE-order string as-is with no reordering step,
which is a real bug (Node's own contract is canonical order,
unconditionally) rather than a deliberate design difference — hence a
fix board, not a permanent divergence.

**Tested by:** `evidence/flagorder-t.ts` (the five-literal table
above) is the measurement of record; corpus-unpinnable per REACH
(latent), so board #119 tracks the fix without a corpus witness.

**Board #119** tracks canonicalizing `.flags` on the native lanes.

**Unit D note (follow-up unit D): the native arm is retired.** The native
lanes run the wasm tier's regex compiler (S065's unit D amendment): a
literal's `.flags` are the canonical string that compiler reports at
build time, and `new RegExp(p, f).flags` is the canonical string it
builds at run time — `/b/ysmig` and `new RegExp("x", "yg")` answer
`gimsy` and `gy` on every lane, as Node does (`/b/yusmig` itself, /i
with /u, is S102's `unicode-casefold` fence on every lane now). `assert.match` messages and
`util.inspect` render the same string. Board #119 is closed by that unit.

**Amendment (increment 24 P4, a regex VALUE reaching a lastIndex-consulting method with a stateful flag):**
a FOURTH site reaches the SAME "representation-impossible, trap rather than lie" stance — a regex reaching
`.test()`/`.exec()`/`.match()` (one group: `.exec()` lowers to `.match()`'s own IR node, operands swapped,
so all three are genuinely ONE mechanism) or `.replace()`'s own NON-GLOBAL branch, as a VALUE (bound
through a `const`, returned from a function, any receiver that is not a literal directly at the call site),
TRAPS on this tier when the regex carries a flag that makes `RegExpBuiltinExec` consult `lastIndex` — where
Node instead tracks it across calls and answers statefully. This tier's `%w.re.Regex` value has no
`lastIndex` field at all (design §3.2 — no refcounting, no mutable per-value state); every risky call site
here starts at a constant position 0, and implementing real statefulness would need a mutable field on
every regex value, a representation change outside this fix's own scope — exactly S003's own "cannot be
represented, so trap instead of lying" shape, not a new kind of divergence. Measured on Node 24.18 (own
construction; FIVE counterexamples across two gate rounds — the fix's own scope changed TWICE under
measurement, both times by disproving a claim this same amendment had made in an earlier draft, not by
extending it):

    const re = /ab/g;
    "abab".match(re);                                    // Node: ["ab","ab"]; here: traps (F1)
    re.test("ab"); re.test("ab");                         // Node: true, false;  here: traps (F1b)
    function mk(): RegExp { return /ab/g; }
    "abab".match(mk());                                   // Node: ["ab","ab"]; here: traps (dynamic, not even const-bound)
    const sticky = /ab/y;
    "ab".match(sticky); "ab".match(sticky);                // Node: ["ab"], null; here: traps (F5)
    "abab".replace(sticky, "X"); "abab".replace(sticky, "X"); // Node: "Xab","abX"; here: traps (F5, a THIRD site)

A LITERAL `g`/`y` receiver at `.test()`/`.exec()`/`.match()`'s own call site is fenced at COMPILE TIME
(SC1120/SC1121, `ts.isRegularExpressionLiteral`-gated) — but that check cannot see what a VARIABLE's own
initializer was or what a function returns, so a value carrying a stateful flag reached these methods
completely unchecked. `.replace()` has NO such frontend fence at all (by design — it accepts an arbitrary
regex expression, literal or value, at every call site), so ITS OWN guard must itself distinguish literal
from value (see below).

MASK IS METHOD-SPECIFIC, corrected TWICE under measurement, not once: the `{test, exec, match}` group traps
on `GLOBAL|STICKY`; `.replace()`'s own non-global branch traps on `STICKY` alone (its global branch forces
its own fresh `lastIndex=0` reset every call — Symbol.replace's own spec algorithm — and is measured safe,
untouched). AN EARLIER DRAFT OF THIS AMENDMENT CLAIMED "sticky is safe for match" — built on a
NON-DISCRIMINATING WITNESS (`/a/y` repeated on "aaa": "a" occurs at every offset, so the printed result
looks identical whether `lastIndex` is tracked correctly or not). A witness that matches EXACTLY ONCE in
its own subject (`/ab/y` on "ab") exposes the real, stateful answer — the vacuity was caught by the SAME
review process that minted the claim, re-deriving the matrix with discriminating witnesses specifically
because a non-discriminating one can certify a live defect as closed. SEPARATELY, a FIRST BUILD of
`.replace()`'s own guard applied unconditionally to EVERY sticky regex reaching the non-global branch —
including LITERAL receivers, which corpus program 1201-regex-replace.ts's own line 19 (two independent
`/b/y` literal expressions) exercises directly — and BROKE that already-landed claim: a regex LITERAL is
freshly constructed on EVERY evaluation (ES2015+ semantics, never cached/shared the way ES5 sometimes
allowed), so it can never carry a stale nonzero `lastIndex` the way a reused VALUE can; the guard now checks
`e.args[0].kind !== "regexLit"` before firing, exactly mirroring why `.test()`/`.match()` never needed this
check themselves (their own literal case is refused upstream at compile time, so their runtime guard
structurally never sees one). Caught by running the full corpus after the fix landed, not assumed safe from
the code's own shape.

WHY THE EXCLUSION IS SAFE — the MECHANISM, not the regression-fixed-1201 observation (that only shows the
exclusion restores a passing corpus program, not that the excluded case is itself correct): Node builds a
FRESH `RegExp` object on every evaluation of a literal — a literal expression inside a loop, or one
re-evaluated at a second call site, never shares state with a prior evaluation. This tier interns regex
LITERALS as one immortal per (pattern, flags) per module (design §3.2) and carries NO `lastIndex` field on
any regex value at all. Both sides therefore start every call at position 0 — not by any observational
luck, but because NEITHER representation has state left over to carry between calls: Node's because each
literal evaluation is a genuinely new object, this tier's because there is nowhere on the value to put it.

THE CONDITION THIS RELIES ON, named as a forward dependency (the same shape design §7.5's own "NAMED
NON-REQUIREMENT: DO NOT INTERN regex.new RESULTS" already registers for the closely related regex.new
interning question, and cites verbatim): regex identity comparison does not compile today — `SC1043:
comparing non-number, non-string values are not supported yet` (measured there: `function mk(): RegExp {
return /a/; } ... mk() === mk()` refuses at compile time) — so a program can never OBSERVE that this tier's
literal is one immortal object where Node's is a fresh one each time. IF SC1043 is ever lifted to admit
reference comparison on regex values, BOTH the regex.new-interning question §7.5 already names AND this
literal-exclusion's own safety become observable at once (Node also creates a fresh object per literal
evaluation: `const f = () => /a/; f() === f()` is `false` there, `true` under this tier's own interning).
At that point this exclusion needs its own re-examination — not because the lastIndex argument above stops
holding (it does not; that argument is about state, not identity), but because a NEW angle opens: an
identity-observing program could, in principle, distinguish "the same immortal literal object, reused
across calls" from "a fresh object every time," which is a different question from whether either one
carries lastIndex. Revisit this exclusion's own safety argument if SC1043 lifts; do not assume the
lastIndex argument alone still settles it once identity is observable.

THE TRAP IS CLASS-WIDE, AND THAT IS DELIBERATE, NOT AN OVER-REACH: the value-path guard fires on the WHOLE
`GLOBAL|STICKY` flag class for a value receiver — it does not, and structurally CANNOT, distinguish an
input that would actually diverge from Node from one that happens to answer correctly anyway. rev's own
pre-arm measurement (rev/prearm-p4v6-guardsites-v1.txt, f4d68540…) names four such probes: inputs where
the pattern matches at every offset in its own subject (so a wrongly-reset `lastIndex` never changes the
printed answer), a sticky value `.replace()` on its own no-match arm (a FAILED sticky match resets
`lastIndex` to 0 in Node too, so there is nothing to carry either way), and two further shapes with no
second-call divergence at all — every one of these was Node-exact on this tier BEFORE this fix and now
TRAPS. Each was correct only by COINCIDENCE, on a witness where the underlying divergence does not happen
to show; this tier has no `lastIndex` field to consult on any regex value, so it cannot tell "lucky, this
particular subject never exposed the bug" apart from "actually wrong" without modeling state it does not
have. Refusing the WHOLE class loudly, rather than trying to special-case the coincidentally-fine inputs
(which would require exactly the state this tier does not carry), is rule 1's own stance applied
consistently — silent-wrong is never acceptable, even where a specific input happened not to show it. THE
READER-FACING CONSEQUENCE, stated plainly: a program in this class that "used to work" on this tier —
printed Node's own exact answer, for whatever specific subject it happened to run against — now TRAPS BY
NAME. That is the fence's own intended reach, not a narrower one limited to the five wrong-answer
counterexamples this amendment measures above; a reader who hits this trap on a previously-working program
should find their own case named here, not conclude the trap over-fired.

Confirmed-safe with NO guard needed anywhere (measured, every flag combination): `search()` (saves, forces
position 0, and restores `lastIndex` around every call, regardless of flags); `replaceAll()`/`matchAll()`/
`matchAllInto()` (all REQUIRE global to avoid the F2 TypeError, and every global operation forces its own
fresh `lastIndex=0` reset, matching what these methods' own loops already do); `split()` (refuses at compile
time for any non-literal receiver, regardless of flags — safe by construction, not a guarded cell at all).

**Tested by:** the wasm emitter unit tests "F1," "F1b," "F1/F1b dynamic value," "F5" (match/test/exec,
three pins, one per source form — `.exec()` measured directly with its own syntax, not inferred from
`.match()`'s own pin, since the two are reached from different source spellings even though they share one
IR node), "F5" (replace's own non-global branch), "F5 safe controls" (replace's own global branch, both
`gy` and no-flags), and the "value-path-flag matrix completion" pins — match's own `/gy` cell (BOTH failure
axes at once: shape, an all-matches array vs the single-match answer; and statefulness, sticky's own
lastIndex advance — match needs a witness for EACH axis separately, since a single-match subject is blind
to the shape axis and a multi-match subject is blind to the statefulness axis), search (all four flags),
matchAll (`g`/`gy`, TWO-CALL), replaceAll (`g`/`gy`, TWO-CALL), and matchAllInto (`g`/`gy`, TWO-CALL, its
own for-of-desugar mechanism, a method an earlier draft of this matrix left out entirely) — all `packages/
compiler/test/wasm-emitter.test.ts`, REACHING pins at the `runWasmToTrap`/`runWasm` level (S003's own
bridge for the trap cells, byte-exact assertions for the safe cells). THE DISCRIMINATION RULE, stated
precisely (an earlier draft of this Tested-by paragraph said "matches exactly once," which is a heuristic,
not the actual property, and is WRONG in general — replace's own witness matches TWICE and still
discriminates fine): a witness is valid when the SECOND call's answer would DIFFER depending on whether
`lastIndex` had advanced, or when the flag changes the result SHAPE (match's own `g`) — never the
"abab"/"aaa" shape that reads identically whether the defect exists or not, REGARDLESS of how many times
the pattern happens to match.

**Amendment (increment 24 P6, the assert surface reaches the same class through FOUR new sites):**
`assert.match`/`assert.doesNotMatch` (ONE libCall/case handles both spellings — a compile-time boolLit
selects the lead-in text only, downstream of the guard, so a value-path GLOBAL/STICKY regex traps
identically for either spelling), `assert.throws`/`assert.rejects`'s regex form (`assert.throwsRegex` —
Node tests `regex.test(String(error))`, the SAME `.test()`-shaped mechanism as the original four sites, just
against a computed subject instead of a plain one), `assert.throws`'s shape form's own regex-valued keys
(`assert.shapeRe` — `{ code/message/name: /pattern/ }`; MEASURED directly that Node's own shape comparator
is ALSO stateful for a value-bound GLOBAL/STICKY regex here, not inferred from the other three), and
`assert.doesNotReject`'s regex form (`assert.regexErrTest`, a pure boolean predicate with no throw of its
own — `doesNotReject`'s OWN control flow decides "unwanted rejection" vs "rethrow raw" from the result).
MASK is the SAME `GLOBAL|STICKY` combination as the original four sites for all four of these (measured per
site, not carried by analogy — team-lead's own GO condition for this pass).

A GENUINELY NEW MECHANICAL WRINKLE, not present in the original four sites: `assert.throwsRegex`/
`assert.shapeRe`/`assert.regexErrTest` (NOT `assert.match`, which lowers directly at its own call site) run
inside a `%assert.throws.N`/`%assert.rejects.N`/`%assert.dnr.N` helper the frontend DEDUPES and SHARES
across every call site with the same (mode, receiver-type, expected-signature) key — for the "regex" and
"shape" forms that key does not depend on what a given call site's own regex expression was, so MULTIPLE
call sites, some literal, some value-bound, can and do funnel into the exact same generated helper body. The
literal-exclusion check the original four sites use (`e.args[N].kind !== "regexLit"`, read directly off the
libCall's own IR argument) is a COMPILE-TIME fact about THAT expression at THAT position — but inside a
shared helper, the regex argument is always a wrapper PARAMETER reference, never the original call site's
own expression, for every invocation regardless of what the caller actually passed. isLiteral is threaded
through as an EXPLICIT extra runtime argument instead (computed per call site by lower-assert.ts's own
`classifyThrowsExpected`/shape-key classification, carried as a wrapper parameter exactly like `msg`/
`hasMsg` already are, and consumed as a RUNTIME i32 branch in the wasm case rather than a compile-time IR-
kind check). A FIRST BUILD of these three cases used the ORIGINAL compile-time-kind pattern verbatim,
copied from `assert.match`'s own case — WHICH IS ALWAYS TRUE for a wrapper-parameter reference, so the
guard fired UNCONDITIONALLY on every call, literal or not, over-trapping a literal `/pattern/y` that Node
(and the original four sites' own exclusion) handles fine. Caught by this pass's own "F5 safe controls" unit
pin — which called the LITERAL forms of `assert.throws`'s regex and shape forms and asserted they complete
Node-exact, exactly the same shape as the original "F5 hard constraint" pin already does for `replace()`'s
own literal receiver — not assumed safe from the code's own shape.

**Tested by:** the wasm emitter unit tests "F5 (INC-24 P6)" — one pin per site (`assert.match`/
`doesNotMatch`, `assert.throwsRegex`, `assert.shapeRe`, `assert.regexErrTest`), each using a regex/subject
pair that Node ITSELF matches (so, absent the guard, the call would succeed silently or hit a catchable
outcome the pin's own try/catch swallows) — a non-matching pair cannot discriminate here, since this tier
implements an uncaught `AssertionError` as a wasm trap too (`%w.err.reportUncaught`), so a bare "did a trap
happen" check passes for a genuine mismatch exactly as readily as for the guard firing; an earlier draft of
these pins used a non-matching pair for three of the four and could not have caught the wrapper-sharing bug
above even though all four appeared to pass — and "F5 safe controls (INC-24 P6)" (the literal forms at all
four sites, byte-exact, the pin that actually found that bug) — all `packages/compiler/test/wasm-emitter.
test.ts`.

**Amendment (board #301): lastIndex is MODELLED — the two amendments above are retired, except assert.throws's
shape form.** Every regex value on every lane now carries `lastIndex` (the wasm lane's `%w.re.Regex` has a
mutable f64 field; the native `ScrRegex` a `last_index`), and every method follows the spec's rules for it,
one algorithm per method on each side (`backend/wasm/regex-state.ts`; `scr_regex.c`, held equal by
`packages/compiler/test/regex-state-fuzz.test.ts`): RegExpBuiltinExec reads ToLength(lastIndex) on a global
or sticky regex and stores the match end, or 0 on failure (`test`, `exec`, `match` without /g, `replace`'s
non-global branch with /y); `match` with /g answers EVERY whole match (it used to be fenced as a different
shape — it is the same `string[] | null`), resetting lastIndex to 0; `replace`/`replaceAll` with /g reset it
to 0 and advance past empty matches by AdvanceStringIndex (/u included); `matchAll` drains the spec's clone,
which starts at ToLength(lastIndex) and never writes the regex; `search` restores it; `split` uses a clone
and leaves it alone. `re.lastIndex` reads and writes (`=`, `+=`, `-=`, `++`, `--`) lower on every lane, and
the flag accessors (`global` … `unicodeSets`) read `.flags`. A regex LITERAL evaluates to a FRESH object
every time, as in JS (the compiled program stays interned; the native emitters hand a literal that is the
direct operand of a regex method its immortal static, which the runtime starts at lastIndex 0 — the
object is unreachable afterwards). Board #302 (a sticky regex value reused in `replace` on the native lanes
— a silent wrong answer) is closed by the same change. The P4 trap sites (test/exec/match/replace) and three
of the four P6 sites (`assert.match`/`doesNotMatch`, `assert.throws`'s regex form, `assert.doesNotReject`'s
regex form) now answer as Node does: Node runs each of them through RegExpPrototypeExec once. The SHAPE form
(`assert.throws(fn, { message: re })`) KEEPS its wasm trap on a value-path g/y regex: on a failed comparison
Node's Comparison constructor runs every regex key a SECOND time, in the expected object's key order,
moving lastIndex again and changing the generated message ("Values have same structure but are not
reference-equal" when the second run matches) — a single verdict cannot reproduce that. The native lanes,
which used to test such a value statelessly from index 0 (a silent divergence on a reused g/y value),
now abort there by name too (`scr_assert_shape_re`). **Tested by:** corpus 2795 and 2796 (c, llvm, wasm against Node); the regex state
fuzz (`regex-state-fuzz.test.ts` — 400 generated rows by default, 2,500 measured, of operation sequences over
one regex object, function replacers that run regexes included, on all three lanes against Node; a
mutation dropping the failure-path lastIndex reset turns it red on each side); the wasm emitter pins that
used to assert the P4/P6 traps now assert Node's stateful answers ("board #301 (was …)").

## S068 — `Math.random`: the same distribution on every lane, deliberately different SEQUENCES; the wasm tier draws once from a host seed *(per-lane split)*

Every lane answers a uniform double in [0,1) at the spec's 53-bit granularity, and no lane reproduces
another's sequence. The native lanes call `arc4random_buf` PER DRAW (`scr_lib.c`'s `scr_math_random`,
`(r >> 11) * 0x1.0p-53`), so the sequence is the platform CSPRNG's and nothing seeds it. The wasm tier has
no CSPRNG of its own: it imports `(import "tsinter" "seed" (func (result i64)))` — present ONLY in modules
that reach `Math.random`, the conditional shape `now` already uses for timer modules — reads it ONCE on the
first draw, and steps V8's xorshift128+ from there. MurmurHash3 of the seed and of its complement give the
two states; ToDouble is the top 53 bits scaled by 2^-53, which is the same value construction the C lane
uses.

THIS ENTRY PINS A V8 VERSION, DELIBERATELY. The transcription mirrors `src/numbers/math-random.cc` (with
`src/builtins/math.tq` for the consuming side) as shipped in V8 13.6.233.17 — Node 24.18.1's V8, verified by
reading that file at nodejs/node tag v24.18.1 (vendored+hashed under `impl-p1/vendor/`: `math-random.cc`
sha256 `594dd4d1…`, `math-random.h` sha256 `f497d4d6…`, `random-number-generator.h` sha256 `1a300df4…`,
`random-number-generator.cc` sha256 `71d1cac5…`, `math.tq` sha256 `a877efef…`). At that version the cache is
refilled FORWARD over 64 entries (`kCacheSize`, `math-random.h:24`), the index is set to 64 and decremented
per draw (so each block is consumed in REVERSE — `math.tq`'s `MathRandom` builtin reads `cache[--index]`),
ToDouble takes the POST-step state0, and the seeding is `MurmurHash3(seed)` / `MurmurHash3(~seed)` IN
`math-random.cc` — NOT the generator class's own `SetSeed` (`random-number-generator.cc:218-223`), which
hashes `~state0_` and is a different thing. A Node upgrade that moves any of the four RETIRES the pin
without making the tier wrong — the toolchain-versioned framing S036 already uses.

WHY A SEED IMPORT RATHER THAN PER-CALL ENTROPY: per-draw entropy is the wrong cost model for a game loop,
V8 itself seeds once, and the ABI's standing position is that the origin of nondeterminism is the host's
business. The differential harness services `seed` from a CSPRNG so that no corpus program can depend on a
fixed sequence; an embedder passing a fixed seed gets a reproducible one (the `node --random-seed=N`
contract).

OBSERVABLE: the VALUES, in order, for a given seed. Nothing else — range, granularity and distribution
agree across lanes by construction. NOT OBSERVABLE, and therefore not part of this entry: whether two lanes
started from the same seed. No tier path can read it.

**Tested by:** 1111's invariant pins (every draw in [0,1), `typeof "number"`, `isFinite`), plus the
seed-to-sequence pin in `packages/compiler/test/wasm-random.test.ts` — with the host seed forced to N, the
module's first 320 draws equal `node --random-seed=N`'s first 320 values exactly, measured across eight
seeds including the int32 edges and -1 (V8 sign-extends the flag into the uint64 seed; seed 0 is
UNSEENED by V8 itself — `--random-seed=0` is indistinguishable from no flag at all, measured directly, two
runs differ — and is therefore excluded from the pin set, not a gap this entry can close). That pin is
possible only because the module replicates V8's 64-entry refill cache, generated forward and consumed in
reverse within each block; it is negative-controlled by a shift mutation, by removing the reversal, by
reading the wrong state slot, by seeding from the wrong half (the generator class's `SetSeed` shape), and
by a v8/main-shaped rewrite (no cache, no reversal, `ToDouble` of the step's return value) — all five must
score 0 (or, for the shift, ~0) against the real oracle.

(The two stale "SEMANTICS.md 62" pointers for randomness — `ir/nodes.ts:1893` and
`packages/runtime/src/scr_runtime.h:804` — cite an entry number that has never described randomness in a
67-entry register, and three more source sites carry the same stale text (`packages/runtime/src/scr_lib.c:
2483`, `packages/compiler/src/frontend/lowering/surfaces.ts:479`,
`packages/compiler/src/backend/emission/emit-exprs.ts:2736`). All five repoint here in the same hunk; a
sixth site, `tests/corpus/2709-math-static-scalar.ts:3`, is a corpus file and stays untouched — recorded as
a residual.)

## S069 — `date.parseGetTime`: outside its two modelled grammars, the wasm tier FENCES by a named catchable Error; the native lanes answer NaN silently *(per-lane split)*

The number was a WITHDRAWN DRAFT in design-number-v6.txt §9.2, for a different subject (a parseInt fence
later replaced by a transcription and never shipped) — a reader of that document should not mistake this
entry for the number's first use.

Two grammars are modelled, exactly: (1) the ASN1_TIME_print certificate-validity shape (`MMM [D]D HH:MM:SS
YYYY GMT`, case-insensitive month, one or two spaces before the day, seconds bounded 0-59 except where noted
below); (2) the strict ECMA-262 Date Time String Format (`YYYY[-MM[-DD]]`, optional `THH:mm[:ss[.sss]]`,
then `Z` or a bounded `±HH:MM`; expanded `±YYYYYY` years; a date-only form is UTC). Inside either grammar, a
NaN the grammar's own numeric-domain rules produce (an hour past 24, a minute past 59, TimeClip, ...) is
usually Node's own NaN and both lanes agree — measured exhaustively over years 0000-9999, not assumed: this
holds for every year on the hour/minute/TimeClip arms of both grammars, but NOT universally. Grammar 1's own
seconds-bound check and BOTH grammars' month/day-bound checks each have a narrow, year-dependent exception
where V8's own legacy parser rereads a field as something else and answers a real, unmodelled time instead
of NaN: grammar 1's seconds field past 59 is reread as a two-digit YEAR, at every tested year (10,000 of
10,000); grammar 1's day field, when invalid (0 or past 31), is reread from the YEAR token at years
0001-0031 specifically; grammar 2's month/day fields, when invalid, are reread from the (bare, non-expanded)
YEAR token at years 0001-0012 specifically. None of these three is modelled — the wasm lane fences all of
them, per the disposition rule below.

Outside both grammars, the two lanes diverge. The native lanes (`scr_date_parse_get_time`, `scr_lib.c`)
answer NaN SILENTLY for every such string — a pre-existing divergence since the key landed, UNREGISTERED
until this entry (INC-25 P6). NaN is a WRONG VALUE for a real input: `new Date("bogus 2020").getTime()`
answers a real time in Node (V8's legacy fallback reads "bogus" as noise and "2020" as the year), never NaN.
MANY unmodelled forms Node accepts this way are LOCAL time — INCLUDING EVERY legacy and offset-less
form — and the tier has no zone import, so even a transcription of V8's own legacy parser
(`deps/v8/src/date/dateparser*.cc`) could not close those without one; this is not the fence's whole
justification, though — a full twenty of the forty-one measured fence-worthy shapes carry an EXPLICIT zone
marker and are stable across six zones (fraction-digit-count variants, case variants, a colon-less offset,
"GMT"/"UTC" word forms), so a zone import alone would not close them either. The fence's real justification
is the one v6 §5.5 gives first: unmodelled is not the same as guessed, and without V8's own parser the tier
cannot tell a real input from a NaN one — "bogus 2020" is the witness. THE RULE HOLDS IN BOTH DIRECTIONS,
and this entry states both: for a measured minority of the fence's own domain (twelve strings, of a
103-row table — `""`, `" "`, `"bogus"`, `"Invalid Date"`, `"20"`, `"20260717"`, `"T12:00Z"`, and five more
lenient-ISO/legacy shapes) Node ALSO answers NaN, and the native lanes are CORRECT today — yet the wasm
tier still throws, because it cannot distinguish "Node also says NaN here" from "Node has a value here"
without the same parser; fencing both uniformly, rather than guessing per string which is which, is the
same tier contract as the "bogus 2020" direction, not a second one.

The wasm tier FENCES instead: a NAMED, CATCHABLE `Error` (S043's stance — a reachable, unmodelled surface
throws loudly rather than answering silently wrong), never NaN, never an uncatchable trap. Message: `date.
parseGetTime: this string is not one of the two modelled date formats (SEMANTICS.md S069) — the
certificate-validity form ("Mon D HH:MM:SS YYYY GMT") or the strict ECMA date-time string format
("YYYY[-MM[-DD]][THH:mm[:ss[.sss]]](Z|±HH:MM)")`. `.code` "SC1090" — diagnostic.ts's own "generic fallback;
message names the construct" family, already shared across every other unmodelled-construct fence in this
backend; no more specific code fits an unmodelled runtime VALUE shape.

Fenced, by measurement: every lenient-ISO shape V8 additionally tolerates (1/2/4/5 fraction digits,
lowercase `t`/`z`, a one-digit month or day, a leading or trailing space, a space in place of `T`, a
colon-less or hour-only UTC offset, a bare `T`-time, a separator-less basic-format date); the three
year-dependent reinterpretation classes named above; a NEGATIVE-signed all-zero expanded year
("-000000..."), any year (Node's own answer for this shape varies by what follows it — NaN with a time
part, a real TZ-moving value for the date-only sub-case — so a fence is the only disposition safe for every
measured variant); the offset-less ECMA date-time (`"2026-07-17T12:00:00"`, `.../T12:00`) — LOCAL per the
spec's own rule; every legacy V8 form (`"Jan 1 2020"`, `"2020/01/01"`, `"1 Jan 2020"`, `"2020-1-1"`).

Board #133 (BOARDS.md): three further pre-existing defects in `scr_date_parse_get_time`'s grammar-2 arm (an
unbounded `±HH:MM` offset field; TimeClip checked before the offset rather than after; the accepted
"-000000" expanded year) — silent-wrong, native lanes only, not this entry's subject but load-bearing for
what the wasm arm does not transcribe. Board #134 (BOARDS.md): a FOURTH, separate defect, in grammar 1 —
on a FULLY VALID certificate-shaped string, the native lanes answer the LITERAL parsed year where Node
applies its own two-digit-year remap (0000-0049 -> 2000-2049, 0050-0099 -> 1950-1999); this is a WRONG
VALUE where both lanes answer a value, not a NaN-for-a-time miss, so it is NOT this entry's class (v6 §9.4:
silent-wrong is fixed, not registered) — the wasm lane models V8's rule directly, as its own two comparisons
and an add, never by reusing `date.utc`'s different (ECMA MakeFullYear) two-digit-year rule.

**Amendment (node:crypto unit, 2026-10-23, Joe's ruling for 2722): a string with no ASCII digit answers
Node's NaN on the wasm tier; the fence keeps every other string.** V8's date parser (`dateparser-inl.h`)
makes a number token only from an ASCII digit, and a date with no number gives its DayComposer no
component, so `DayComposer::Write` fails and `Date.parse` answers NaN for EVERY digit-free string — the
ES5 arm and the legacy arm alike, whatever words, signs, zone names or non-ASCII digits (Arabic-Indic,
fullwidth) it holds. Measured: 600,021 random digit-free strings (keyword soups and arbitrary non-digit
ASCII/Unicode) all answer NaN under Node v24.18.1. So the fence's domain narrows by exactly that
class: `""`, `" "`, `"bogus"` and `"Invalid Date"` of the twelve Node-NaN strings above now answer NaN
on the wasm tier, the same answer as the native lanes; every string containing an ASCII digit and
outside both grammars still fences ("bogus 2020", the other eight Node-NaN strings — `"20"`, `"20260717"`, `"T12:00Z"`
and the five numeric lenient-ISO/legacy shapes), because Node answers a real time for some such strings. The check runs only after both grammars declined, so no modelled
answer moves.

**Amendment (local time zone unit, 2026-10-26, S113): the offset-less ECMA date-time is no longer fenced or
NaN — it is LOCAL time on every lane.** `"2026-07-17T12:00:00"`, `"2026-07-17T12:00"`, `"2020T12:00"` and every
other grammar-2 date-time with no `Z` or `±HH:MM` answer Node's value: V8's ParseDateTimeString bounds the
local value to ±(8.64e15 + 10 days), converts it with ToUTC under the host's zone (S113: the wasm tier asks
its host through `tsinter.tzCall`, the native lanes ask the C library), then TimeClips. The native lanes'
silent NaN for this form (this entry's "outside both grammars" paragraph listed it) is gone, and the fence
message now spells the offset as optional: `("YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:MM]]")`. Every other
fenced shape above — the legacy forms, the lenient ISO shapes, the reinterpretation classes — is unchanged:
those need V8's legacy parser, not a zone.

**Tested by:** 1572 (native lanes ONLY — it is NOT a wasm-tier member: under the per-pass stub sweep it
refuses on `crypto.x509FingerprintStr`, a key outside this pass), plus `wasm-date.test.ts`'s genuine
differential rows (the modelled grammars, computed against `new Date(x).getTime()` in-process, including
the two-digit-year remap) and its fence-only rows (no Node expectation exists for a fence's own text; the
test asserts the message/`.code` the wasm lane itself produces, per v6's own instruction for value
contracts with no oracle). The amendment: 2722 (wasm census — its `new Date("bogus")` row) and
`wasm-date.test.ts`'s digit-free row (twenty-three strings against Node in-process; "bogus 2020" and
"Invalid Date 1" join the fence-only rows).

## S070 — `process.argv[0]` and `process.argv[1]`: LENGTH and POSITIONS match Node on every lane; the VALUES do not *(per-lane split)*

Node answers `[<the node executable's absolute path>, <the script's own path>]`. Neither non-Node lane
reproduces this — both give `argv[0]`/`argv[1]` a DIFFERENT, tier-specific pair, MEASURED directly rather
than assumed:

**Native (both lanes — `c` and `llvm` — identical, built and run):** `["scriptc", <the invocation string, EXACTLY
as typed>]`. `argv[1]` is the literal command line the process was invoked with, not a resolved path:
invoked `./prog`, `argv[1]` is `"./prog"`; invoked by absolute path, it is that absolute path; invoked
`./renamed-prog` (after a rename), it is `"./renamed-prog"`; invoked from a subdirectory
(`./native-default/prog`), it is `"./native-default/prog"`. `process.execPath` (S071) IS the resolved
absolute path and follows a rename where `argv[1]` does not — the two must never be conflated.

**Wasm:** the host's own two strings for `hostStr` kinds 0 (argv[0]) and 0 (argv[1] at index 1) — the ABI
requires two non-empty strings (abi.ts §2.2/§2.4) but says nothing about their content beyond that; the
differential harness serves `["scriptc", <the module path>]`, matching the native lanes' own shape so all
three lanes read alike to a program that only checks length, non-emptiness, and (per 2441) mutability.

RETIRES the two argv-values citations in the tree, both unnumbered — a single-line grep for the phrase
finds only one; the second is line-wrapped, which is exactly why it must be re-derived by reading rather
than grepped for and trusted at face value: `packages/runtime/src/scr_runtime.h:1945` (`scr_lib_init`'s own
header comment) and `packages/runtime/src/scr_lib.c:158-159` (`scr_process_argv`'s own, wrapped across two
comment lines). Both a DEAD upstream register number the same way "divergence 12"/"60" (S071/S072) are:
cited with no number, no prior entry naming either, until this one.

**Tested by:** 990 (length 2, both non-empty, identity/mutation across all three lanes — never the VALUES,
which this entry is why); 2441 (the fixture explicitly overwrites `argv[0]`/`argv[1]` before printing the
array, exactly because the values are this entry's own divergence). Native argv[0]/argv[1]/execPath
measured directly this pass (both lanes, four invocation shapes each) rather than transcribed from an
earlier session's numbers.

## S071 — `process.execPath`: Node answers the node executable's own path; every non-Node lane answers something ELSE, and the answers differ across lanes too *(per-lane split)*

Node's `process.execPath` is the absolute, resolved path of the `node` binary that is running the
script — never the SCRIPT's own path (that is `argv[1]`, S070's own subject; the two must not be
conflated).

**Native (both lanes — `c` and `llvm` — identical, measured):** the COMPILED BINARY's own resolved
absolute path, and it FOLLOWS A RENAME where `argv[1]` does not (S070): invoked as `./prog`, `execPath`
answers the binary's own resolved absolute path, not the literal string `"./prog"`; renamed to
`./renamed-prog`, `execPath` follows the rename while `argv[1]` stays whatever string invoked it.

**Wasm:** the host's own string, read through `hostStr` kind 12 (abi.ts §2.2) — the ABI text requires a
non-empty, absolute-shaped string but says nothing about ITS content beyond that (the same weak-value
stance the `wallClock` precedent already documents). The differential harness serves the MODULE'S OWN
PATH, so a program reading `isAbsolute(execPath)` / `execPath.length > 0` / identity across two reads
passes identically to the native lanes without ever printing the raw value (1468's own contract).

RETIRES "divergence 12" at its four source sites (each a doc-comment naming this key by the OLD phrase,
never printing a number): `packages/runtime/src/scr_runtime.h:1990`, `packages/compiler/src/ir/
nodes.ts:2987`, `packages/compiler/src/frontend/lowering/lower-builtins.ts:4839`, and `packages/compiler/
ambient/scriptc-node-fallback.d.ts:176` (SHIPS to users — not "only types"), plus the corpus's own
citation at `tests/corpus/1468-exec-path.ts:2` (comment-only, never printing the number either).

**Tested by:** 1468 (isAbsolute, non-empty, cross-read identity, non-empty basename — the CONTRACT all
three lanes share, never the value); native execPath measured directly this pass (both lanes, two
invocation shapes: as-invoked and after a rename) rather than transcribed from an earlier session.

## S072 — `process.versions.node` / `process.versions.openssl`: every non-Node lane answers a fixed COMPATIBILITY TARGET, not a live version *(per-lane split)*

Node answers the actual engine build's own version strings. Every non-Node lane answers the SAME two
constants regardless of the machine or the moment: `"24.0.0"` (`versions.node`) and `"3.5.5"`
(`versions.openssl`) — the runtime semantics this project verifies against, measured this pass against a
live Node v24.18.1 / OpenSSL 3.5.7 on the same machine (deliberately different from both, so no program
could mistake one for the other).

**Native (both lanes) and wasm:** identical constants on all three non-Node lanes; the wasm lane's answer
crosses through `hostStr` kinds 6/7 (abi.ts §2.2), served by the differential harness as the SAME two
literals (design §11).

`process.versions.openssl`'s OWN role is Node's "is crypto available" idiom
(`Boolean(process.versions.openssl)`), not a version comparison — 1639 asserts presence and `typeof`
only, never the raw string, matching this entry's own stance (a live crypto surface exists here; the
string just never claims to BE a live OpenSSL's own version).

RETIRES "divergence 60" at its FIVE `versions.node`-subject source sites (the subject is the DECLARATION
the comment sits on, never a sibling stance it cites — the trap the design's own register section
names): `packages/runtime/src/scr_lib.c:202`, `packages/runtime/src/scr_runtime.h:1997`, `packages/
compiler/src/ir/nodes.ts:2995`, `packages/compiler/src/frontend/lowering/lower-builtins.ts:4756`, and
`packages/compiler/ambient/scriptc-node-fallback.d.ts:137` (SHIPS), plus the corpus's own citation at
`tests/corpus/2702-process-arch-versions.ts:4`. NEVER `packages/compiler/src/frontend/lowering/
lower-stmts.ts:3636`/`:3679` — those cite the SAME phrase for a DIFFERENT topic (the record-delete/
`= undefined` collapse, board #136) and stay exactly as they are.

**Tested by:** 1531 (the dotted shape's segment count, the major-version gate `>= 24`, a NaN check on the
parsed major, and the doctor idiom's presence-gated template literal — the DERIVED facts a real caller
uses, never the raw string) and 1639 (`typeof`/presence only, gating a "crypto-path"/"skip-path" choice
the same way Node's own idiom does).

## S073 — fs errors carry `.code` and Node's exact `.message` ONLY; `.errno`/`.syscall`/`.path` are UNREPRESENTED, and Node's own SystemError class/wording for rm-without-recursive on a directory is not modelled *(wasm tier; native lanes ship the same divergence)*

Node's fs errors are decorated `Error` instances (or, for one shape below, a `SystemError`) carrying
`.code`, `.errno`, `.syscall`, and `.path`. Every non-Node lane throws a PLAIN `Error` whose `.code` and
`.message` match Node's exactly; `.errno`, `.syscall` and `.path` are UNREPRESENTED — nothing in the closed
corpus reads them (measured over the closed set; widening to the full four stays UNPICKED, D6 ERRATUM 1).

On the UNKNOWN arm (an errno outside the module's own fourteen-code enumeration — ENOENT, EEXIST, EACCES,
ENOTDIR, EISDIR, ENOTEMPTY, EPERM, EBADF, EMFILE, ENOSPC, EINVAL, EROFS, ELOOP, ENAMETOOLONG — the last two
appended by ERRATUM E-P4-3, delta-3e e4da1096 R-1: reached by ORDINARY `readFileSync` inputs, a symlink loop
and an overlong path, so the twelve-only table printed a knowingly-wrong "Unknown system error" for inputs a
user will actually hit), `.code` renders `E<n>` (NEVER a Node spelling) with the MODULE CONSTANT text
`"Unknown system error -<n>"`, sourced from libuv's own table shape rather than the host platform's
`strerror` (measured: glibc's `strerror` and libuv's table differ on every code compared, not merely in
case). The arm is unreached by the generator and by every corpus program — measured against
`packages/compiler/test/fs-errno-rows.json` (sha256 `e3ceac84f41fcf4a110c0ca52242fc6125153d499334a98cac89013d62dd3789`:
43 rows, generated under uid class "non-root", every code inside the fourteen — the file's own header and
row count are the citation, not a transcribed number that can go stale as the table grows). `EBADF`, never
reachable through a path-based op, is reached through the fd-based ops P5 added to this same table —
`closeSync`/`readSync`/`readFdSync`/`readFdSyncBytes` — a stated limitation, not a silent one.

SECOND SENTENCE: where Node throws a DIFFERENT ERROR CLASS — `rmSync`/`rmOptsSync` on a directory WITHOUT
`recursive: true` throws a `SystemError`, `.code` `"ERR_FS_EISDIR"`, `.syscall` `"rm"`, message `"Path is a
directory: rm returned EISDIR (is a directory) <path>"` (no `"EISDIR:"` prefix, path UNQUOTED — measured)
— every non-Node lane throws a PLAIN `Error` with that SAME wording instead (the class divergence itself is
observable: `instanceof`/`constructor.name` differ). `rmdirSync` on an EMPTY directory does not throw;
`rmSync`/`rmOptsSync` WITH `recursive: true` does not throw either — the divergence is specific to
rm-without-recursive on a directory. `mkdirSync(p, {recursive: true})`'s own return value (the first
created directory, or `undefined`) is FENCED to statement position on every lane (no lowering exists for
reading it) — the SAME dead number this divergence sits on, not a second one.

**Native (both lanes) and wasm:** identical `.code`/`.message` construction from the SAME closed enumeration
(`packages/runtime/src/scr_lib.c`'s `scr_fs_throw`/`scr_rm_fail_set` on the C lanes; `fs.ts`'s own hand-
written table, independently checked against a generated-from-Node rows file, on the wasm lane) — never a
platform errno crossing raw.

RETIRES the dead "divergence 13" at its THREE source sites whose SUBJECT is this entry (the subject is the
declaration a comment sits on, never a sibling stance it cites): `packages/runtime/src/scr_lib.c:1449` (the
property-set sentence), `packages/runtime/src/scr_lib.c:1963` (the rm-on-directory class/wording, this
entry's second sentence), and `packages/compiler/src/ir/nodes.ts:3907` (the SAME rm-on-directory wording,
plus the fenced `mkdirSync` recursive return). ALSO rewrites `tests/corpus/1472-errno-code.ts:2`'s header BY
CLAUSE — that comment spans THREE families (fs, kill, exec) under the one dead number; it now names this
entry for its fs clause and S077 for its kill clause, leaving exec's own clause an UNREGISTERED citation
(board #137).

NAMED RESIDUE, NOT retired here (a different SUBJECT appealing to the same dead number, read and confirmed
by SUBJECT rather than assumed by phrase): `packages/runtime/src/scr_dgram.c:41` and `tests/fixtures/dgram/
cases/udp-error-code/main.ts:3` (dgram's OWN `.code`-only stance, a sibling family's citation of the same
dead number — board #137); `tests/corpus/1473-promisify-execfile.ts:38` (a DIFFERENT subject — `execFile`'s
own reads answering `undefined` — cites "divergence 13/50", and 50 is a LIVE number elsewhere, so this site
is left exactly as it stands rather than partially retired).

**Tested by:** 1306-errors-runtime-instances.ts (a real, uncontrived `ENOENT: no such file or directory,
open '<path>'` from `readFileSync` on a missing file — one of the pass's two message-exact corpus
witnesses); the errno table's own forced-host unit rows, driven against a table GENERATED from real `node:fs`
runs (never transcribed from this entry or from the native C source) and independently cross-checked byte-
for-byte against a second, separately-written measurement; a forced row for the rm-on-directory class/wording
above, pinning both the `SystemError`-vs-`Error` class difference and the exact unprefixed, unquoted message.

## S074 — `fs/promises` runs its syscall SYNCHRONOUSLY and mints an ALREADY-SETTLED promise; I/O never interleaves with timers or other fibers *(native and wasm lanes; the same divergence, one mechanism)*

Node's real `fs/promises` schedules the syscall onto libuv's own thread pool and settles the returned
promise from a completion callback, so other timers, immediates, and concurrently-pending promises can run
WHILE the I/O is in flight. Every non-Node lane instead runs the SAME synchronous syscall this tier's own
`fs`/`fs.*Sync` family already uses, and wraps the outcome directly into a promise that is already settled
the instant it is returned — a pending exception in the active cell becomes the REJECTION (Node's own
fs/promises failures reject rather than throw, so this matches the catchable-at-`await` shape exactly), and
anything else FULFILLS with the payload. The rejection's `.message` is the SAME sync text S073 registers
(no separate wording for the promise form).

ONE mechanism, TWO observables, ONE entry serving both: the SETTLING ITSELF — a pending exception moved out
of the active cell into the promise's rejection slot before that promise is ever returned to the caller
(`scr_promise_settled_common`, `packages/runtime/src/scr_async.c:1387`, the subject of the block comment's
own citation at `:1379`) — and the NON-INTERLEAVING this produces (the `fs/promises` bridge's own block
comment, citing the same divergence again at `:1430`, immediately before `scr_fsp_read_file` and its
siblings): a program that AWAITS its fs/promises calls sequentially cannot observe the difference (the
result and its timing relative to ITS OWN later statements are Node-exact), but a program that races an
fs/promises call against a timer, an immediate, or another concurrently-pending promise CAN — the sync
call runs to completion, and everything else queued for that same turn waits behind it, where Node would
have let them interleave. The wasm lane's own fsp twins (`fs.readFile`/`writeFile`/`rm`/`stat`/`mkdir`/
`mkdirRecursiveMode`/`unlink`/`chmod`/`readdir`/`readFileBytes`, P5's own construct) share this exact
stance — `emitFspSettled` wraps the SAME sync fs.ts helpers the ordinary `fs.*Sync` calls use, via the
module's own already-settled-promise minting (`this.proms.mint()`/`this.proms.settle()`), never new async
machinery (design §6.5) — so one entry covers both lanes rather than a per-lane split.

RETIRES the two unnumbered citations whose SUBJECT is this mechanism: `packages/runtime/src/scr_async.c:1379`
(inside the block comment introducing the `scr_promise_settled_*` family, immediately before
`scr_promise_settled_common` at `:1387`: "the documented non-interleaving divergence, SEMANTICS.md") and
`packages/runtime/src/scr_async.c:1430` (inside the `fs/promises` bridge's own block comment, immediately
before `scr_fsp_read_file`: "DOCUMENTED DIVERGENCE (SEMANTICS.md): the syscall blocks the event loop..."). A
THIRD, unrelated citation sits nearby in the same file at `:575` (`scr_timer_refresh`'s own dead-handle
no-op: "SEMANTICS: Node re-activates even a fired Timeout; the compiled handle cannot") — a DIFFERENT
SUBJECT (re-activating an already-fired timer, not fs/promises), logged here as residue under board #137,
not retired by this entry and not touched.

**Tested by:** 1357-fsp-roundtrip.ts and 1569-fsp-mkdir-unlink-chmod.ts (both lanes — confirmed native AND
wasm claim and pass them byte-exact this pass), exercising the settled-fulfillment and settled-rejection
paths across the full fsp surface; #143's own native corpus rows (1461/1531/2314) as an unrelated-mechanism
negative control, confirming this entry's own native code paths (`scr_promise_settled_*`) sit beside, and
are unaffected by, that rider's three separate C-lane fixes.

## S075 — `process.getActiveResourcesInfo()` reports only the resource KINDS this tier's own event loop models *(wasm tier; native lanes ship the same divergence)*

Node's real answer enumerates every live libuv handle by KIND — timers, sockets, file-descriptor
requests, and more. This tier's own event loop tracks exactly two kinds — `Timeout` (the heap of armed
`setTimeout`/`setInterval` entries) and `Immediate` (the `setImmediate` queue) — so its answer is a
SUBSET of Node's by construction: every resource kind this tier does not model as a loop handle (TCP
wraps, FS requests, and everything else libuv tracks that this tier has no representation for) is simply
ABSENT from the array, never a placeholder or an approximation.

Node itself EXCLUDES unref'd handles from this same call (measured this pass: an unref'd `setTimeout`
answers `[]`), and the wasm arm matches that exclusion exactly by reading the SAME reffed-only counters
`timers.ts` already maintains for its own loop bookkeeping (the heap's own reffed count, gated by the
currently-firing entry's own ref/cleared flags — a firing, un-cleared Timeout counts as active for the
duration of its own callback, Node's own Timeout lifetime) — no new state, a pure read. The array itself
groups BY KIND, every `Timeout` before every `Immediate`, regardless of arming order (measured against
Node directly this pass: `getActiveResourcesInfo()` never interleaves the two kinds).

RETIRES the unnumbered citation at `packages/runtime/src/scr_async.c:611` (inside the doc comment on
`scr_active_resources`'s own declaration: "Resource kinds this runtime does not model as loop handles ...
are absent — SEMANTICS.md names the divergence").

**Tested by:** 2314 (no-handles / a firing-uncleared Timeout still counting / `clearTimeout` from inside
dropping it immediately / a fired Immediate no longer counting — all via `.filter()`, never printing the
full array) plus a forced-host row printing the FULL, unfiltered array (2314 never exercises that shape)
and a forced-host row pinning the unref'd-handle exclusion (2314 never unrefs anything).

## S076 — the `promise` argument of `unhandledRejection`/`rejectionHandled` listeners has no preserved identity *(wasm tier only)*

**RETIRED by INC-26 B1 (board #140, commit pending at this pass's landing): the promise argument is now
boxed as a DK.PROMISE-kind dyn value carrying the underlying promise reference (`dyn.ts`'s own
`strictEq` already compared DK.PROMISE by that reference — the SAME "box is a boundary artifact, never
the identity" shape FUNC-kind values get for their boxed closure — this entry's fix was to box the
REAL promise there instead of a fresh generic object, at BOTH dispatch sites,
`emitter.ts`'s `dispatchOrReport` and `fireRejectionHandled`). Observables 1-3 below are FIXED, measured
against Node v24.18.1 (identical text, both lanes). Observable 4 (`instanceof Promise`) remains
UNCHANGED — a SEPARATE, pre-existing tier limitation (`SC1090`, no class-graph representation for
`Promise` to test against) this board does not touch; still no corpus program or forced-host row can
pose that specific check. This entry stays COUNTED (an append-only register never loses an entry) —
historical citations keep resolving; the header above is unchanged text, describing the divergence AS
IT STOOD before this fix, for exactly the reader that entry text is still correct history for.**

RULING P1-R6 (an earlier, RETIRED draft used this same number for a different, never-landed text — a
synchronous-firing-timing divergence that was superseded by an implementation before it ever merged; this
entry is unrelated to that draft and stands alone). The promise argument of the unhandledRejection and
rejectionHandled listeners is a fresh, unrelated box EVERY fire (`dyn.boxObj`/`pushNewObj`, never the
promise that triggered it), which costs FOUR separable observables Node preserves (rev-26's own measurement
against Node v24.18.1, six answers, all confirmed true there):

1. `p === originalPromise` — the promise reference the program itself holds. Answers false here.
2. Equality BETWEEN THE TWO EVENTS: `rejectionHandled`'s own argument `=== ` the promise
   `unhandledRejection` received for the SAME rejection. THE SHARPEST LOSS — this is how a real Node
   program correlates "this was reported unhandled" with "this got handled later" (the common idiom is a
   `WeakMap<Promise, reason>` set in the first listener and read in the second, keyed by the promise
   argument itself — Node's own documented pattern for this exact pair of events). Answers false here:
   the two events box two INDEPENDENT fresh objects, with no relationship to each other at all.
3. Use as a `WeakMap`/`Set` key across calls — a direct consequence of 1 and 2, named separately because
   it is the shape most programs actually use rather than a bare `===`.
4. `p instanceof Promise` — MEASURED, not assumed, and sharper than a true/false answer: the wasm tier
   cannot even POSE this specific check, on the fresh box or on ANY value — `promise instanceof Promise`
   refuses to compile at all (`SC1090`: "'instanceof' right-hand sides other than classes declared in the
   program is not supported yet"), because `Promise` has no class-graph representation this tier's
   `instanceof` can test against. Confirmed this is Promise-specific, not a general instanceof-vs-builtins
   gap: the identical shape against `Error` (`e instanceof Error`) compiles and runs. So no corpus program
   or forced-host row can ask observable 4 at all here, on either lane's model of any promise value, while
   Node answers true.

THE CARVE-OUT, stated so a reader does not suspect an unrelated program: the REASON argument's identity
holds on BOTH lanes, unaffected by any of the above — 2212 (`2212-unhandled-rejection-listener.cjs`)
asserts this directly (`assert.strictEqual(err, reason)`) and passes today; that same fixture only checks
`typeof promise === "object"` for the promise argument, never its identity, so it neither exercises nor
contradicts this entry.

Found while diagnosing why mutation M-16 (drain the rejectionHandled queue in LIFO instead of FIFO order)
reddened nothing: the test row meant to prove FIFO order relied on the listener's own argument to
distinguish which promise fired — observable 2 above, restated as a test-construction problem rather than
a program-observable one. That is not merely a gap in one test row; it is an observable difference from
Node for any program using the common `WeakMap`-keyed idiom (observables 2/3).

**Tested by (historical, pre-INC-26-B1):** the FIFO-order row (retired — see wasm-host-process.test.ts's
own comment, kept as a count-only assertion that the listener fires exactly twice, no longer claiming an
order it cannot observe) and M-16 (retired-with-reason: reddens nothing BECAUSE the axis is unobservable
by construction, a measured statement about this entry, not a missing pin).

**RESTORED by INC-26 B1 (board #140):** the FIFO-order row and M-16 are back as REAL instruments —
wasm-host-process.test.ts's own count-only row is replaced by an order-asserting one (its comment
updated to say so), and M-16 (drain the rejectionHandled queue in LIFO instead of FIFO order) now
reddens the restored row, since the listener argument can distinguish which promise fired again.

## S077 — `process.kill`'s and `process.chdir`'s thrown Errors carry `.code` and Node's exact `.message` ONLY; `.errno`/`.syscall` (kill) and `.errno`/`.syscall`/`.path`/`.dest` (chdir) are UNREPRESENTED *(wasm tier only)*

Node's own `kill`/`chdir` failures are `ErrnoException`s carrying `.errno` (the raw platform number),
`.syscall` (`"kill"`/`"chdir"`), `.code` (the errno NAME), and — for `chdir` — `.path`/`.dest`-shaped path
context. The wasm tier builds a plain `Error` with `.code` and Node's own exact `.message` text (measured
against Node, never transcribed from the C runtime) and stops there: `.errno`, `.syscall`, and (for
`chdir`) `.path`/`.dest` are simply absent — a program that reads `e.code`/`e.message` sees Node's own
answer; a program that reads `e.errno`/`e.syscall`/`e.path`/`e.dest` sees `undefined` where Node answers a
value.

Each import's UNKNOWN arm (an errno this tier's own enumeration does not name — unreachable on Linux by
construction, since Linux's `kill(2)`/`chdir(2)` only ever answer the codes each enumeration lists) renders
a spelling that is NEVER a Node spelling either: `kill`'s is `"kill E<n>"` with NO `.code` at all
(reproducing the native C runtime's OWN asymmetry — `scr_kill_send`'s `errno`-printing fallback carries no
code either; board #143b names the native lane's OWN further divergence on this same key); `chdir`'s is
code `"E<n>"` with text `"Unknown system error -<n>"`, sourced from libuv's own generic errno-name table,
never `strerror`.

Design v7's own D6 ERRATUM 1 scopes a SEPARATE, sibling entry (S073, landing with P4's filesystem errno
table) to the three fs-side properties as they stand today; WIDENING S073 to a fourth property is
explicitly UNPICKED there. This entry is the alternative the pre-read chose (A-1): a NEW number for these
TWO process-family keys now, rather than pulling `kill`/`chdir` into S073's own scope a pass early — two
numbers, one topic each, is the safe direction when a later pass's own register entry does not exist yet
to widen.

**Tested by:** a forced-host row per named code (`kill`: ESRCH/EPERM/EINVAL; `chdir`: the eight-code table)
confirming `.code` matches Node's own name and `.errno`/`.syscall`/`.path`/`.dest` are all `undefined`; one
forced-host row per import's UNKNOWN arm, pinning the non-Node spelling exactly as this entry states it.

## S078 — `process.emitWarning`'s DISPATCH TIMING: the wasm tier is NODE-EXACT (deferred through its OWN `nextTick` queue); the native (C) lane dispatches SYNCHRONOUSLY *(per-lane split)*

Node's `process.emitWarning` never dispatches synchronously at the call: the default report and every
registered listener fire after the CURRENT synchronous section finishes, through `process.nextTick`
(measured this pass: with a listener and no other timer/tick surface, `on('warning', ...); emitWarning(x);
console.log('main')` prints `main` before the listener fires; a `nextTick` registered strictly BETWEEN two
`emitWarning` calls fires strictly between their two dispatches — ONE marker per `emitWarning` CALL, never
one marker draining every pending warning at once, or the interleaving with a caller's OWN nextTicks would
come out in the wrong order). Per warning, Node's own bootstrap 'warning' listener — registered before any
user code runs — fires BEFORE any user listener, and the default report it prints is unconditional: it
never checks whether a user listener is registered.

**C (native, both lanes):** dispatches SYNCHRONOUSLY, at the call — the deprecation/warning surface predates
this tier's own nextTick queue and was never re-plumbed through it.

**Wasm:** defers through the SAME `process.nextTick` queue a user's own `process.nextTick` calls use (a
per-`emitWarning`-call raw marker posted onto the tier's own queue, `nexttick.ts`'s stage-B seam — the
SAME mechanism `stream.ts`'s own deferred stream emissions already use), so a program mixing `emitWarning`
and `process.nextTick` interleaves exactly as Node's own does. Per warning, the default report prints
FIRST, then registered listeners fire in registration order — matching Node's own bootstrap-listener-
first EventEmitter order exactly.

RETIRES "SEMANTICS.md 138" at its two source sites (a citation with NO PRIOR ENTRY — missed by board
#137's own dead-number census because it is spelled without the word "divergence"):
`packages/runtime/src/scr_async_dyn.c:436` and `packages/runtime/src/scr_runtime.h:3550`, plus the
corpus's own unnumbered citation at `tests/corpus/2215-process-emit-warning-exit.cjs:8-9` — that program's
own comment states it is BLIND to this axis (it prints from an `'exit'` listener with every emit already
finished, so synchronous and deferred dispatch produce an IDENTICAL transcript); the forced-order row is
the only instrument for this entry, stated as such rather than left implying 2215 is a second witness.

**Tested by:** a forced-host order row (a program with NO timer surface at all, pinning `main` before any
listener fires); a forced-host interleaving row (`emitWarning(A); process.nextTick(T); emitWarning(B)`,
pinning Node's own A/T/B order against a drain-all mistake's A/B/T); a forced-host report-then-listener
row per warning. Independently re-measured this pass against a live Node v24.18.1 rather than transcribed
from the design phase's own numbers.

## S079 — `**` beyond its exact cases answers the bits of ONE glibc build's `pow`: Ubuntu GLIBC 2.43-2ubuntu2.4's x86-64 FMA variant (`__ieee754_pow_fma`); Node's own last bit depends on the platform's libm, and the tier matches Node on that build *(wasm tier; the native lanes call the platform's libm `pow`, as Node does)*

Node's `**` is not one answer. V8's live entry (`v8::internal::math::pow`, with `use_std_math_pow`
on by default in Node v24.18.1's V8) answers these cases itself: a NaN exponent → NaN; an infinite
exponent with a base of +1 or -1 → NaN; a NaN base → NaN; an exponent of exactly 2 → `x * x`; an
exponent of exactly 0.5 → +Infinity for an infinite base, else `sqrt(x + 0)`. Every other operand pair
goes to the C library's `pow`. On Linux that is glibc, and glibc chooses its `pow` build at load time by
CPU: on the machine this tier is measured against (Ubuntu GLIBC 2.43-2ubuntu2.4, libm.so.6 sha256
1c488db6f4fe8cecb72456bc018de000b7a9b539c2994864b0416b5e8371b3d8) an x86-64 CPU with FMA3 and AVX2
runs the FMA build (`__ieee754_pow_fma`), whose last bit depends on where that build's compiler fused
`a*b+c`. With FMA and AVX2 masked (`GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2,-FMA,-FMA4`) the SSE2 build
answers differently on 1,887 of 3,000,000 fixed inputs, every time by one ULP, and Node follows whichever
build is loaded — except at the exponents 2 and 0.5, which V8 answers itself. glibc's `pow` is not
correctly rounded either: on about 1 call in 1,200 its answer is one ULP from the correctly rounded one,
and Node's answer is glibc's (`packages/compiler/test/wasm-pow-u6.test.ts` C04 lists eight such inputs
with Node's bits).

**What the tier does.** `**` — the static operator, `**=`, and the checked-dynamic route — computes
through one helper (`emitter.ts` jsPowHelper): the ECMA-262 special-value ladder, V8's two pre-cases
(`x * x` for 2; `f64.sqrt(x + 0)` for 0.5), then a transcription of ARM optimized-routines' `pow` (the
upstream of glibc's; `packages/compiler/src/backend/wasm/pow.ts`, with its tables in `pow-tables.ts`) on
its fma code path, with every multiply-add that the glibc FMA build fuses computed by an exact software
fused multiply-add (WebAssembly has no fma instruction; relaxed-simd's is not deterministic). Of those 21
fused sites, 9 change a result on inputs found so far (one row each: M01–M08, M12; M09–M11 pin three
unfused sites whose fusion would), 1 cannot by construction, and 11 were not observed to in 2.28 billion generated rows —
a statement about those rows, not a proof that they cannot. So the tier answers the bits of that glibc
build on every host: bit-exact to Node on the measured platform. A literal-literal `**` still folds at
compile time at S036's boundary, and the folded value is computed by a TypeScript transcription of the
same helper — same tables, same fused sites, same exact fma — never by the compiling host's `**`; it uses
only IEEE-754 binary64 + - * / and a correctly rounded `Math.sqrt`, so the folded bits equal the run-time
bits on every engine the compiler runs on.

**The divergence registered.** On a host whose Node runs a different `pow` — glibc's SSE2 or FMA4 build
(a CPU without FMA3/AVX2), another distribution's glibc build, musl, macOS, Windows, or a non-x86 CPU —
the tier and that host's Node can differ in the last bit of `**` for a general exponent; none of those is
claimed. Exact on every host: the special-value ladder and the exponents 2 and 0.5. The exponents 1 and -1
are NOT exact by construction: Node answers them from libm too, and `x ** -1` differs from `1 / x` on
about 1 in 1,200 random bases (C07). `Math.pow` computes through the same helper in every build, so
its bits are `**`'s (S100; N01 plain, N02 `--dynamic`). A NaN result of the negative-base family
NaN is the machine's invalid-operation NaN, made at run time as Node's own path makes it (S036; board
#158, fixed).

**The native lanes (c, llvm).** `**`, `**=` and `Math.pow` call `scr_js_pow` (scr_lib.c), a line-for-line
port of V8 13.6's `v8::internal::math::pow` (src/numbers/ieee754.cc, `use_std_math_pow` on): the two
ECMA-262 NaN answers (`quiet_NaN()`), a NaN base quieted, `x * x` for 2, `+Infinity` / `sqrt(x + 0)` for
0.5, and everything else the C library's `pow` — the SAME library function Node calls on the same
machine, so the native lanes match Node there bit for bit, NaN payloads included, on every host whose
Node links that libm (measured: this x86-64 glibc host). A literal-only `**` folds at compile time by the
wasm tier's own rule and transcription (`backend/float-fold.ts`), as Node's parser folds it. Board #207
(the ±1 ** ±Infinity NaN, the pre-cases, the literal fold) is fixed by this; the residue is the
platform's libm, the same residue Node itself has.

**Tested by:** `packages/compiler/test/wasm-pow-u6.test.ts` — the special-value cells (L01–L07), V8's two
pre-cases and the unit-base NaN (P01–P03), bit tables through the core (C01–C09, incl. every
overflow/underflow branch and the rows where a correctly rounded answer would miss Node), one row per
observable fused or unfused multiply-add (M01–M12), the checked-dynamic route (D01–D02), the literal fold
against the same operands at run time (X01–X03), and the lockstep of the two transcriptions (Z01–Z02).

## S080 — a tagged template's per-site strings array is NOT frozen: a write that Node rejects succeeds here, and the two build modes diverge from each other too *(scope stated per lane and per module mode below)*

Node freezes each tagged-template call's per-site strings array (`Object.isFrozen` true, unobservable
here — SC2020 — lowering it is not licensed by this entry) — a widened write to that array throws in
strict mode. This tier's per-site interned array (a plain, writable GC vec, INC-27 U2's own per-key
lazy-global design) carries no such check, and the two ways a value can widen enough to attempt the
write diverge from EACH OTHER, not just from Node:

**PLAIN** (`p = site() as unknown as string[]`, then `p.push(...)` or `p[i] = ...`): the write lands on
the SAME array object the site's global caches — later evaluations of the SAME site see the mutation.
This is the WASM TIER's own answer; the native lanes (llvm, c) SEGFAULT on this exact shape instead of
answering anything (a separate, pre-existing defect under board #162 — NOT licensed by this entry and
NOT this unit's to fix). Node (ESM/strict mode, the corpus's own module mode): the write throws
(`TypeError: Cannot add property N, object is not extensible` for an out-of-bounds push, `TypeError:
Cannot assign to read only property 'N' of object '[object Array]'` for an in-bounds index assignment —
both measured against Node v24.18.1), and a later evaluation is unaffected (frozen, never mutated). In a
CommonJS/sloppy script, `push` still throws (both module modes reject an out-of-bounds add), but an
in-bounds INDEX WRITE is SILENTLY IGNORED instead of throwing (`q[0] = "Q"` leaves the array unchanged,
no exception) — measured against Node v24.18.1.

**--DYNAMIC** (`q: any = site()`, then `q[i] = ...`): the value crosses the `unknown`/dyn boundary on its
way into `any` — S014's own rule (crossing that boundary COPIES; mutations on the far side do not
propagate back) — so the write lands on a COPY, not the interned array. No throw. This answer is the
SAME on every lane measured (wasm and llvm) — the --DYNAMIC half is NOT wasm-tier-only, unlike the
PLAIN half above. Node (ESM/strict mode): still throws here too (`any` is a TypeScript-only erasure, not
a distinct runtime object on Node's side) — a later evaluation of the SAME site is UNCHANGED regardless
(the original was never touched, whether Node threw or the tier silently copied). This tier's
own answer for the CommonJS/sloppy index-write shape (an untyped `.cjs` source, so the value
already carries the S014 unknown-boundary copy without an explicit `any` cast) is the SAME
shape as --DYNAMIC's above, not a third one: the write is visible through the value it landed
on, and a second, independent evaluation of the same site is unaffected (row75) — only the
module mode changes which mechanism produces the copy (an explicit cast vs. an untyped source),
not the observable answer.

**Amendment (unit H, S115): --DYNAMIC now matches Node's strict code.** A typed value crossing into
`any` is a live VIEW of the static value, not a copy, and a template literal's strings array (TS
`TemplateStringsArray`) crosses as a FROZEN view: an in-bounds index write throws `TypeError: Cannot
assign to read only property 'N' of object '[object Array]'`, growth throws `TypeError: Cannot add
property N, object is not extensible`, a `length` write throws the read-only text, and the site's
interned array is untouched and is the same array at every evaluation (`q === site2()`), on every
lane. Node's sloppy code ignores the in-bounds write instead of throwing. The untyped `.cjs` shape
(row75) still crosses through the `unknown` boundary and keeps the answer above.

**ISLAND TAG** (unit A2, wasm tier: an `any`-typed tag in a `--dynamic` build,
jsOp tplStrings): the strings array, with its `raw` member, interns per site like the
PLAIN array — the same object at every evaluation, as in Node — and is likewise not
frozen: an index write lands on it and later evaluations of the site see it, where Node's
strict code throws and its sloppy code ignores the write. The same holds for its `raw` array
(`a.raw[0] = "Z"` lands; Node's strict code throws "Cannot assign to read only property '0' of
object '[object Array]'") and for growth (`a.push("x")` lands; Node throws "Cannot add property <length>,
object is not extensible"); assigning `a.raw = 1` throws this tier's "Cannot create property 'raw'
on array" (S016's non-index write) where Node throws "Cannot assign to read only property 'raw' of
object '[object Array]'".

This is one half of board #161 (a PRE-EXISTING miscompile: an `Object.freeze`-then-cast value elsewhere
in the tier is not respected either) — #161 itself is NOT licensed by this entry and is NOT this unit's
to fix; this entry documents the template-strings-array shape of the same underlying gap (no freeze
representation at all, not an `Object.freeze` call this tier mishandles).

**Tested by:** row43 (PLAIN — the value after the write, AND a second evaluation of the same site showing
the array still carrying the mutation), row44 (--DYNAMIC — since unit H the frozen view's two
TypeErrors, AND a second evaluation of the same site showing the ORIGINAL, unmutated, identical
array), and row75 (a `.cjs`/sloppy-
mode program pinning the silently-ignored index write, contrasted with Node's own sloppy-mode answer) in
`packages/compiler/test/wasm-smalls-u2.test.ts`. All three rows pin the ABSENCE of a check — no mutation
is expected to redden any of them on its own; a mutant that allocates a FRESH template-site array on
every evaluation instead of reusing the interned one reaches row43 as a measured side effect (a fresh
array on the second PLAIN evaluation would show an UNMUTATED array, contradicting what row43 expects), a
fact recorded in the rows-file battery's own reach table rather than invented as a dedicated mutant for
this entry.

## S081 — `arguments` inside a variadic (rest-marked) JS function is a real array on every tsinter lane: Node's Arguments exotic object is not synthesised

A JS function that reads its own `arguments` binding with no declared parameters ahead of it (the sloppy-
mode idiom this tier models internally as a rest-typed func value, restAbi absent) gets, on every lane —
llvm, c and wasm, on both the DIRECT-call path and the VALUE path (a rest-typed function crossing a dyn
boundary) — a REAL, ordinary array: the same boxed rest vector `(...args)` would build. Node's
`arguments` is a distinct exotic object (a live view over the call's bindings in sloppy non-strict mode;
in strict mode it is UNMAPPED — not linked to the parameters — but still an ordinary writable, extensible
object, not frozen; it carries its own `[Symbol.iterator]`, `callee`, and `length`/index own-properties)
— this tier never constructs that object; it hands back the plain array the rest-parameter machinery
already builds.

The two answers AGREE on reads that do not depend on the exotic object's own identity, its
live-binding behavior, or its `Object.prototype.toString` tag: for-of iteration order and content,
indexed reads (including an out-of-range index, `undefined` on both), `.length` (read, not write),
membership (`0 in arguments`, `'length' in arguments`, `Object.hasOwn(arguments, 'length')`), `typeof
push`/`join`/`forEach` (`"undefined"` on both — neither object exposes them as own properties directly
on `arguments`), `typeof arguments` (`"object"`), `arguments == null` (`false`), `!!arguments` (`true`),
`Object.keys(arguments)` and `JSON.stringify(Object.entries(arguments))` (both `"0,1"` /
`[["0",1],["1","two"]]`). Tested by AGR-1..4 and AGR-o10 in `packages/compiler/test/wasm-funcrest-u3.test.ts`
— stated for completeness, not separately registered.

The two answers DIVERGE on the eleven observables below, each measured against Node v24.18.1 (`arguments`
inside a CLASS or STATIC method is a DIFFERENT construct, not this entry's territory: there the front
end folds `arguments.length` to the declared parameter count in a TypeScript file only where every
invocation is a direct call tsc arity-checks — the method never extracted, its class without heritage, its
instances never typed through another member of that name — refuses it by name in a TypeScript file
otherwise, and refuses it by name in a JavaScript file, where a caller may pass any count — board #164,
GH #22). The same eleven observables hold when such a variadic function is handed to a builtin that calls
it — the array iteration methods and a sort comparator pass every argument Node passes, a composite one
(the array) crossing by S014's copy:

`.callee` — strict mode: Node throws a TypeError reading it (`'caller', 'callee', and 'arguments'
properties may not be accessed`) where this tier answers `undefined` (S081-8, a strict `.cjs`). Sloppy
mode: Node answers `"function"` for `typeof arguments.callee` where this tier answers `"undefined"`
uniformly on both the direct-call path and the value path (S081-9, a sloppy `.js`).

`util.inspect`/`console.log(arguments)` — Node prints `[Arguments] { '0': 1, '1': 'two' }`; this tier
prints the plain array form `[ 1, 'two' ]` (S081-1, strict `.cjs`).

`JSON.stringify(arguments)` — Node's Arguments object serializes as an OBJECT with numeric-string keys
(`{"0":1,"1":"two"}`); this tier serializes as an ARRAY (`[1,"two"]`) (S081-2, strict `.cjs`).

`Array.isArray(arguments)` — Node answers `false` (an Arguments object is not an Array); this tier
answers `true`, including the zero-argument twin (S081-3, strict `.cjs`).

`String(arguments)` / template coercion — Node's Arguments object has no custom `toString`, so it falls
to `Object.prototype.toString` and answers `"[object Arguments]"`; this tier answers the array's own
join-based `String()`, e.g. `"1,two"` (S081-5 `String()`, S081-6 the template form; both strict `.cjs`).

String concatenation (`'x' + arguments`) — same divergence, Node's `"x[object Arguments]"` vs this
tier's `"x1,two"` (S081-7, strict `.cjs`).

An index WRITE past the current length — Node's Arguments object accepts an arbitrary own-property
write without growing `.length` (writing index 0 and index 5 on a 2-argument call leaves `.length` at
2); this tier's array grows `.length` to accommodate the write, matching ordinary JS array semantics
(S081-10, strict `.cjs`).

`[].concat(arguments).length` — `Array.prototype.concat` does not special-case an array-like non-Array,
so Node's result is `1` (the whole Arguments object concatenated as ONE element); this tier's result is
`2` (the array's own two elements spread in, matching ordinary `Array.prototype.concat` over a real
array) (S081-11, strict `.cjs`).

Writing `.length` directly — Node's Arguments object accepts the write as an ordinary own-property
assignment with no truncating/padding side effect on the actual indexed values (no throw); this tier
treats `arguments` as the dense array it is here (S110 (f), unit H): a shorter length TRUNCATES it,
a longer one throws the catchable `Error: growing a dynamic array's length past its elements (the
holes Node leaves) is not supported yet on the wasm lane` (S081-12, strict `.cjs`; before unit H the
TypeError `"Cannot create property 'length' on array"`).

**LOUD REFUSALS** (not divergences, and not compile-time refusals either — each of these four constructs
COMPILES on every lane and fails at RUN TIME with a named, deferred diagnostic, `"Uncaught Error: ...
is not supported yet [SC1090 at file:line]"`, printed before the program stops — a trap on wasm, exit 1
on the native lanes; never a value, never silent): `Object.prototype.toString.call(arguments)`,
`arguments instanceof Array`, spreading `arguments` into an `unknown[]`-typed position, and
`arguments[Symbol.iterator]`.

**Scope:** both native lanes (llvm, c) and wasm; both the DIRECT-call path and the VALUE path (a
rest-typed function crossing a dyn boundary) on wasm; module mode is strict `.cjs` for every observable
except S081-9 (a sloppy `.js` — `.callee`'s own divergence is per-mode, stated above). Corpus
1703-arguments-rest-props.cjs is a further direct-call proof. Board #164 owns `arguments` inside class
and static methods (a different, front-end-level construct), not this entry's territory.

**Tested by:** S081-1, S081-2, S081-3, S081-5, S081-6, S081-7, S081-8, S081-9, S081-10, S081-11, S081-12
(each a direct/value twin pair), AGR-1..4 and AGR-o10, and the four LOUD REFUSALS (each a direct/value
twin pair) in `packages/compiler/test/wasm-funcrest-u3.test.ts`.

## S082 — `process.nextTick` callbacks and microtasks (`queueMicrotask`, a `Promise` `.then` handler) drain in the SAME relative order on every tsinter lane, regardless of module mode; Node's CommonJS order is not reproduced

Node schedules two separate queues after each turn of synchronous top-level code: the **next-tick
queue** (`process.nextTick`) and the **microtask queue** (`queueMicrotask`, `Promise.prototype.then`).
In a CommonJS (`.cjs`) or CommonJS-mode `.ts` module (this tier's oracle mirror runs a `.ts` file with no
extension-forced module type as CommonJS, matching its `package.json`'s `"type"`), Node drains the
**next-tick queue first, then the microtask queue**, independent of the two calls' relative registration
order — `process.nextTick(a); queueMicrotask(b);` and `queueMicrotask(b); process.nextTick(a);` both
print `a` before `b`. In an ES module (`.mjs`, or a `.ts`/`package.json` pair typed `"module"`), Node
drains the **microtask queue first, then the next-tick queue** — the same two call orders both print `b`
before `a`. (Both queues still drain in FIFO order internally; this entry is about the queues' relative
priority, not intra-queue order.)

This tier's queues — on every lane, llvm, c and wasm — always drain in the ES-module order: microtasks
before next-tick callbacks, regardless of the source file's module mode (`.cjs`/`.ts`-CommonJS or
`.mjs`) and regardless of the two calls' registration order. A same-body program run as `.cjs` and as
`.mjs` therefore AGREES with Node on the `.mjs` twin and DIVERGES from Node on the `.cjs`/`.ts`-CommonJS
twin — this tier has, in effect, only one ordering rule where Node has two.

**Unaffected (both queues agree with Node, every lane, every module mode):** a next-tick callback that
itself schedules a microtask, and a microtask that itself schedules a next-tick callback. Measured:
`queueMicrotask(() => { console.log("micro"); process.nextTick(() => console.log("tick-from-micro")); })`
prints `micro` then `tick-from-micro` on Node (`.cjs` and `.mjs` alike) and on every tsinter lane;
`process.nextTick(() => { console.log("tick"); queueMicrotask(() => console.log("micro-from-tick")); })`
prints `tick` then `micro-from-tick` on Node (both module modes) and on every tsinter lane. A three-way
race registers a `Promise.resolve().then` handler FIRST, then a `queueMicrotask` callback, then a
`process.nextTick` callback, at the top level, in that order — `Promise.resolve().then(() =>
console.log("then")); queueMicrotask(() => console.log("micro")); process.nextTick(() =>
console.log("tick"));` — and prints (Node `.cjs`) `tick, then, micro`; (Node `.mjs`) `then, micro,
tick`; (every tsinter lane, every module mode) `then, micro, tick` — the `.then` handler and
`queueMicrotask` keep their OWN relative (registration) order against each other on every lane and
every mode; only their priority against `process.nextTick` follows this entry's rule.

**Scope:** llvm, c and wasm; `.cjs`, `.mjs`, and CommonJS-mode `.ts` source files; both registration
orders of the two top-level calls. Not yet fixed — board #169 owns bringing the `.cjs`/CommonJS-mode
ordering in line with Node's; this entry registers the CURRENT (divergent) behavior, not a target.

**Tested by:** S082-cjs-nt-first (the `.cjs` divergent cell, both registration orders), S082-mjs-agree
(the `.mjs` agreeing twin, both registration orders), S082-nest-agree (the two nesting shapes, agreeing
on every lane and mode — a stated non-divergence), S082-three-way (the next-tick/`.then`/`queueMicrotask`
race, divergent cell + agreeing `.mjs` twin) in `packages/compiler/test/wasm-funcrest-u3.test.ts`. The
CommonJS-mode `.ts` cell and the native (llvm, c) lanes are MEASURED, not pinned by a row. Measured
against Node v24.18.1 and this tier's own llvm/c/wasm lanes.

## S083 — a typed `.finally` handler's returned promise is not waited for, and a dynamic `import()` evaluates its module at a different microtask position than Node, on every tsinter lane *(llvm, c and wasm)*

A typed `.finally` handler that RETURNS a promise: Node waits for the returned promise (and then the
adoption jobs) before settling the derived promise. Beside a chain of observers `o1 … o5` (`|` separates
lines; Node v24.18.1 and this tier's llvm, c and wasm lanes, which agree) Node prints
`o1|o2|o3|finally-adopt 3|o4|o5`. This tier does not wait for the handler's promise at all. It settles the
derived promise from the original value and prints `o1|finally-adopt 3|o2|o3|o4|o5`. The cause is the
front end's lowering: a typed `.finally` callback is accepted only as `() => void`, and the returned
promise is dropped as the void value before any adoption could see it.

**A promise resolved WITH another promise — RETIRED (board #170; every lane).** This entry used to
register the typed adoption cells. Node adopts a promise resolved with a promise through the spec's thenable
job: the outer promise settles TWO jobs after the inner one, where this tier settled it one job after. That
covers a `then`/`catch` handler returning a promise, an async function's `return p` without `await`, an
async concise arrow `async () => p`, and `Promise.try`'s callback. The front end lowers each of these as a
`return await p`. They are now ADOPTED: `p` evaluates, one microtask hop stands for
NewPromiseResolveThenableJob, and then the await subscribes to `p` from inside that job. That is Node's two
jobs, with Node's registration order on `p`. Every lane runs the same IR (`Lowerer.adoptPromise`). The
formerly divergent cells now print Node's answers on llvm, c and wasm:
- a `then` handler returning a promise prints `o1|o2|o3|adopted 9|o4|o5`;
- a `catch` handler, `o1|o2|o3|catch-adopt 9|o4|o5`;
- a handler returning `Promise.resolve(9)`, `o1|o2|o3|resolved-p 9|o4|o5`;
- a nested adoption, `o1|o2|o3|o4|o5|nested 9`;
- a rejected promise adopted, `o1|o2|o3|o4|rejected-adopt|o5`;
- an async function's `return p`, `o1|o2|async-return-p 9|o3|o4|o5`;
- the four-step then-chain, `sync|o1|o2|o3|adopted 9|o4`;
- plain JavaScript's untyped `async function f() { return g(); }` and `const f = async () => g();` in a
  `.cjs`, `sync|o1|o2|f 7 number|o3`.

An async void concise arrow `async (): Promise<void> => p` used to drop `p` without waiting for it, and so
settled before `p` did. It now adopts `p` like any other return. An async GENERATOR's `return p` is the
spec's single Await (no resolve function is involved) and keeps the plain await. These were always Node's
and are unaffected: `return await p` (`o1|return-await 9|o2|…`), a plain `await p` (`await 9|o1|…`),
`Promise.resolve(p) === p` (true, settling before `o1`), and an awaited value returned.

**Dynamic `import()` timing (measured separately):** the tier
evaluates a dynamically imported module at a different microtask position than Node relative to
observers scheduled beside the `import()` call. A program importing a synchronous module beside
`o1 … o5` prints (Node) `sync|o1|o2|o3|o4|m-init|o5|imported 7`, (wasm)
`sync|m-init|o1|o2|imported 7|o3|o4|o5`, (llvm, c) `sync|o1|o2|o3|o4|o5|m-init|imported 7`; one
importing a module that itself awaits prints (Node)
`sync|o1|o2|o3|o4|m-start|o5|m-after-await|o6|imported 8`, (wasm)
`sync|m-start|o1|m-after-await|o2|o3|o4|o5|imported 8|o6`, (llvm, c)
`sync|o1|o2|o3|o4|o5|o6|m-start|m-after-await|imported 8`. The imported module's output and the imported
values are Node's; only the interleaving differs, and the wasm lane's order also differs from the llvm
and c lanes' order. Not yet fixed; owned by board #181.

**A promise held in an `any` — RETIRED (boards #176, #177, #182, #184; wasm lane).** This paragraph
registered two cells where the wasm lane's island bridge read an `any`-held promise one job off Node (an
island `.then` handler returning such a promise was adopted one job early, board #182; `await` of one
resumed one job late, board #184). Both now take Node's timing: a promise resolved with an `any`-held
promise adopts it through the spec's thenable job (`async function g(): Promise<any> { return x; }`,
`new Promise((r) => r(x))`), `Promise.resolve(x)` and `await x` use the held promise itself, and an
island `.then` / `.catch` / `.finally` on one runs the dyn reaction machinery — beside `o1 … o5`
observers, `Promise.resolve(x).then` prints `sync|resolve any 7 number|o1|…`, `return x` prints
`sync|o1|o2|async-return any 7 number|o3`, `await x` prints `sync|await any 7 number|o1|…`, and the then-adoption
cell prints `sync|o1|o2|o3|adopted 7 number|o4`, all as Node does (rows in
`packages/compiler/test/wasm-adopt.test.ts`; ISL01–ISL02, Z05–Z09b now assert Node's answers). As in Node,
a promise resolved with an `any`-held promise is already resolved while the adoption runs: a later
`resolve(v)` or `reject(e)` of it is ignored (`new Promise((res) => { res(x); res(1); })` fulfils with
`x`'s value). What is NOT covered here, and is not a registered divergence: an `any` holding a NON-promise
object-kind value — a plain object, a function, an array, an imported module's namespace — whose `then`
is callable is not adopted; resolving a promise with one is a named run-time refusal ("resolving a promise
with a non-promise thenable is not supported yet"). A host handle held in an `any` (a net, http, tls,
dgram or child-process object) is never a thenable — none of Node's has a `then` — and resolving a promise
with one fulfils it with the handle, as in Node. A promise of a STATICALLY typed destination resolved
with an `any`-held promise (`async function g(): Promise<number> { return x; }`, `new Promise<number>((r)
=> r(x))`, a typed `Promise.withResolvers` resolve — board #234) adopts it the same way, with Node's two
jobs, and the cast to the typed slot applies to the ADOPTED value: a value that does not fit rejects the
destination with the boundary's TypeError at adoption (S009's checked-cast footing; Node, untyped,
fulfils). An ordinary typed function called with an `any`-held promise is not a resolve function and
keeps the boundary's TypeError at the call. The same holds for an ordinary typed function that RETURNS
one through a typed result: a typed `.then` / `.catch` handler such as `(): number => x` casts `x` as its
own return value, inside the handler, before the derived promise's resolve function sees anything — so
`Promise.resolve(1).then((): number => x)` rejects with the boundary's TypeError where Node adopts and
fulfils with the held value (a registered divergence of this entry, wasm lane). Rows TY01–TY19 in `wasm-adopt.test.ts` (TY19 pins the
handler cell).

**Scope:** llvm, c and wasm; a typed `.finally` callback's returned promise; `import()` on every lane as
stated.

**Tested by:** S07 and S15–S16 (the divergent cells, asserting this tier's order with Node's in a
comment), S01–S06, S08 and S17–S29 (the retired adoption cells, now asserting Node's answers), S09–S12
(the agreeing controls) and S13 (a late `catch` against
`rejectionHandled`: the wasm lane prints Node's `unhandled|late catch|rejectionHandled`; the llvm and
c lanes print `unhandled|rejectionHandled|late catch`, a native-only divergence owned by board #180 —
not an adoption cell, recorded here because the row is this entry's control) in
`packages/compiler/test/wasm-async-u4.test.ts`. The llvm and c lanes are MEASURED, not pinned by a row
(board #170's cells re-measured on llvm and c at the retirement: every one prints Node's answer).
Measured against Node v24.18.1 and this tier's own llvm/c/wasm lanes.

## S084 — a record field typed `void` is DROPPED from the object on every tsinter lane: `Object.keys` omits it and `"w" in r` answers false, where Node keeps the key holding `undefined` *(llvm, c and wasm — RETIRED by board #178)*

**Retired (board #178).** Record shapes now carry each field's `?` (IrRecordShape's `optional`), and a
field declared without one is an own key whatever it holds: `{ a: number; w: void }` built as
`{ a: 1, w: v() }` answers `Object.keys(r).length` 2 and `"w" in r` true, as in Node, on every lane
(rows VF01-VF03 in `packages/compiler/test/wasm-async-u4.test.ts` now assert Node's answers). What is
left of the old rule — an OPTIONAL field holding `undefined` counts as absent — is S091. What follows is
the entry's history.

A record whose declared type has a field of type `void` (`{ a: number; w: void }`), built from a literal
that fills that field with a void call (`{ a: 1, w: v() }`) or a void `await` (`{ a: 1, w: await v() }`),
has an own key `w` holding `undefined` in Node. This tier does not store the field at all: the key is
absent from the object. Every read that goes through the field's NAME still agrees with Node — `r.w` is
`undefined`, `JSON.stringify(r)` omits the undefined value in both, and `console.log(r)` prints
`{ a: 1, w: undefined }` on every lane — but every question about the object's KEYS differs.

Measured cells (`|` separates lines; the void call prints `v ran`):
- `const r: { a: number; w: void } = { a: 1, w: v() }` with a synchronous `v`, then
  `console.log(r.a, r.w, JSON.stringify(r), Object.keys(r).length)`: Node `v ran|1 undefined {"a":1} 2`;
  llvm, c and wasm `v ran|1 undefined {"a":1} 1`.
- the same inside an async function after an unrelated `await 0`: the same four answers.
- the field filled by `await v()` with an async `v` (the void operand runs as its own statement and the
  field is dropped): Node `v ran|1 undefined {"a":1} 2`; llvm, c and wasm `v ran|1 undefined {"a":1} 1`.
- the same record printed and probed: `console.log(r)` then `console.log("w" in r)`: Node
  `v ran|{ a: 1, w: undefined }|true`; llvm, c and wasm `v ran|{ a: 1, w: undefined }|false`.

The first two cells are the long-standing record lowering; the `await` cells became reachable on the wasm
lane in INC-27 U4, when a void `await` in a record literal stopped being refused (the llvm and c lanes
already compiled them, with the same answer).

**Scope:** llvm, c and wasm; a record field whose declared type is exactly `void`. Not yet fixed —
board #178 owns keeping the key; this entry registers the CURRENT behavior, not a target.

**Tested by:** VF01 (the synchronous cell, a pin of the pre-existing path), VF02 and VF03 (the `await`
cells) in `packages/compiler/test/wasm-async-u4.test.ts`, each asserting this tier's answer with Node's in
a comment. The llvm and c lanes are MEASURED, not pinned by a row. Measured against Node v24.18.1 and this
tier's own llvm/c/wasm lanes.

## S085 — child_process's synchronous surface: uncaptured outputs read `""`, errors carry name, message and code only, `spawnSync`'s `error` is fresh per read, the exec family has no maxBuffer, promisified `execFile` settles synchronously, the default echo is raw, and an explicit `cwd: ""` is the current directory *(llvm, c and wasm, per clause below)*

`spawnSync`, `execSync`, `execFileSync` and promisified `execFile` (`const execFileAsync = promisify(execFile)`) differ from Node in these ways, each on every lane unless the clause says otherwise:

- **(a) Uncaptured and failed-spawn outputs read `""`.** A `stdout`/`stderr` that is not captured (stdio `"ignore"` or `"inherit"`) reads `""` where Node reads `null`, and `execSync`/`execFileSync` with an `encoding` RETURN `""` where Node returns `null` when stdout is not captured (without an `encoding` such a result can only be discarded: the front end refuses any other use by name); the outputs of a child that could not be spawned read `""` where Node reads `undefined`. `.output` and `.pid` are not lowered (front-end fences). A result read through `status`, `signal` or `error` is Node-exact on the wasm lane (the llvm and c lanes' cells: board #209).
- **(b) Errors carry `name`, `message` and `code` only.** This holds for the asynchronous family too: the `'error'` event of a `spawn` that failed ("spawn <file> <CODE>") carries name, message and code on every lane; on the wasm lane so do the failures `spawn` throws at once ("spawn <CODE>") and `kill`'s ("kill <CODE>") — the llvm and c lanes do not throw the former (board #213), and the latter are shown only by a scripted host. Node's extra error properties (`status`, `signal`, `stdout`, `stderr`, `pid`, `output`, `errno`, `syscall`, `path`, `spawnargs`) are absent, so an UNCAUGHT `execSync`/`execFileSync` failure prints the tier's uncaught report (`Uncaught Error: Command failed: ...`) where Node prints its stack and those properties; and promisified `execFile`'s "Command failed" rejection has no numeric `code` (Node: the exit status, or `null` for a signal). This registers the exec clause board #137 recorded as unregistered (`tests/corpus/1472-errno-code.ts`'s header); that site is retired by subject with the others below.
- **(c) `spawnSync`'s `error` is a fresh Error on every read.** Node hands back one object, so `r.error === r.error` is `true` there and `false` here, and a property written through one read is not seen through the next.
- **(d) The exec family has no maxBuffer.** `execSync`, `execFileSync` and promisified `execFile` capture without limit (the lowering accepts and drops `maxBuffer`; Node's default is 1 MiB, past which it throws ENOBUFS, or rejects with "stdout maxBuffer length exceeded"). `spawnSync`'s own 1 MiB default (the front end refuses a `maxBuffer` option there) is Node-exact on the wasm lane and not enforced on the llvm and c lanes (board #209).
- **(e) Promisified `execFile` runs the child to completion before its promise settles, with stdin at end-of-file** — Node runs it asynchronously with stdin open (S074's class, for child_process): a timer armed before the call fires after the promise settles here and before it in Node, and a child that reads stdin sees end-of-file here where Node's waits for the timeout. Its argument-validation errors (the timeout, a NUL byte, an empty file name — validated in Node's own order, timeout first) REJECT the returned promise here where Node throws them synchronously from the call: different only for a call not awaited inside a `try`.
- **(f) The default-stdio echo is raw.** With no `stdio` option, `execSync`/`execFileSync` write the child's captured stderr to the parent's stderr before returning or throwing; this tier writes the RAW bytes, where Node with an `encoding` option writes the DECODED string (different only for invalid UTF-8: Node `EF BF BD`, here the original byte). Without an `encoding` both write the raw bytes.
- **(g) An explicit `cwd: ""` runs the child in the current directory**, where Node fails the spawn with ENOENT (the lowering spells an absent `cwd` as `""`). The asynchronous `spawn` agrees with Node here: Node's own `spawn` runs a child given `cwd: ""` in the current directory too.

This entry is what the "documented divergence" / "documented stance" citations of this subject now mean; those sites are not edited: `packages/runtime/src/scr_child.c` (the file header's parity notes, the spawnSync options core's comment, the exec core's error-properties comment); `packages/runtime/src/scr_runtime.h` (the `scr_spawn_sync`, `scr_spawn_sync_opts` and `scr_exec_sync` contracts); `packages/compiler/src/frontend/lowering/lower-builtins.ts` (`lowerSpawnSyncCall`'s doc comment, `lowerExecSyncCall`'s stdio comment, `lowerExecFileAsyncCall`'s doc and its maxBuffer comment, "divergence 50"); `packages/compiler/src/ir/nodes.ts` (the `cp.spawnSync` member's doc); `packages/compiler/ambient/scriptc-node-fallback.d.ts` (the child_process declarations' notes); and the corpus programs 1360, 1472 (its header's exec clause), 1473 ("divergence 13/50"), 1482 ("divergence 27"), 2362, 2697 and 2708.

**Scope:** llvm, c and wasm, except where a clause names a lane. The llvm and c lanes differ from Node in further cells the wasm lane does not (board #209); those are not registered here.

**Tested by:** U1-REG-01 (a), U1-REG-02 and U1-HYG-02 (b), U1-REG-03 (c), U1-REG-04 (d), U1-REG-05 and U1-REG-11 (e), U1-REG-06 (f) and U1-REG-07 (g) in `tests/harness/wasm-differential.test.ts` ("INC-28 U1 child_process rows"), each asserting this tier's answer beside Node's in its source or comment; for the asynchronous family, U2-REG-05 (b: `console.log` of a failed spawn's error shows `code` and no other property) and U2-SPN-10 ((g)'s agreeing sentence) in the same file ("INC-28 U2 child_process async rows"), and U2-FH-16 and U2-FH-17 in `packages/compiler/test/wasm-host-cp-u2.test.ts` (b's kill half, through a scripted host). The llvm and c lanes are MEASURED against the same sources, not pinned by a row. Measured against Node v24.18.1.

## S086 — child_process on the wasm lane: inherited output is written after the child exits, a grandchild holding it delays the call, a mixed inherited stream counts against `spawnSync`'s default maxBuffer, `"ignore"` and `"inherit"` stdin are an empty socket, a promisified `execFile` timeout counts the host's spawn, a `'data'` listener added while the child runs gets buffered output at the next poll, and close-together children's exits and ends follow the host's reads *(wasm lane only)*

On the wasm lane the host runs each child with its own synchronous `spawnSync` and the module reads the finished result (`tsinter.cpCall`, abi.ts). Five consequences differ from Node:

- **(a) Inherited output is written after the child exits.** A `stdout`/`stderr` given stdio `"inherit"` is captured by the host and written by the module, raw, as soon as the call returns: the bytes on each stream keep Node's order with the program's own writes, but output a child interleaves across stdout and stderr is not interleaved the way a terminal would show it (not observable by the differential harness, which captures each stream separately).
- **(b) A grandchild holding an inherited stream delays the call.** A child that leaves a background process holding the inherited stream (`(sleep 0.5; echo late) & ...` under `stdio: "inherit"`) makes the call wait until that process closes it, and its output lands before the parent's next write (Node: the call returns when the child exits; the late output arrives later).
- **(c) A mixed inherited stream counts against `spawnSync`'s default maxBuffer.** A `spawnSync` with one output inherited and the other captured applies Node's 1 MiB default to the inherited stream too: past it the child is killed with SIGTERM and the result carries ENOBUFS, where Node's inherited stream has no limit. A `spawnSync` with no captured output is unlimited, as in Node.
- **(d) `"ignore"` and `"inherit"` stdin are an empty socket.** A child's stdin given as `"ignore"` (`spawnSync`'s literal and tuple forms, `execSync`/`execFileSync` — the lowering carries `"ignore"` on stdin as `"pipe"`) or as `"inherit"` (every form) is a socket already at end-of-file, where Node opens `/dev/null` for `"ignore"` and passes its own stdin for `"inherit"`. A child reads end-of-file either way; the difference shows only to a program inspecting the descriptor's kind. `spawnSync`'s runtime stdio string `"ignore"` is Node-exact (`/dev/null`).
- **(e) A promisified `execFile` timeout counts the host's spawn.** The host's synchronous spawn counts the cost of starting the child against the timeout, so a promisified `execFile` with a timeout shorter than that cost can kill a child Node lets finish (Node arms the asynchronous timer after the spawn). Synchronous `spawnSync`/`execSync` count the spawn in Node too. Measured on this host: a 10 ms timeout kills `/bin/echo` here where Node resolves; a 2000 ms timeout agrees with Node.

Since INC-28 U2 the host also starts ASYNCHRONOUS children, with its own `spawn` (`tsinter.cpCall` op 5), and the module reads their events from the host's queue when its event loop polls (`tsinter.evPoll`, abi.ts). Five more consequences differ from Node:

- **(f) Output an asynchronous child inherits is written when the event loop polls.** The host captures a stream given as `"inherit"` (or as the program's fd 1 or 2) and the module writes each chunk at its next poll, so a program that writes while a child is writing, without the loop polling in between (a busy synchronous stretch), puts its own line first where Node puts the child's first. Each stream's own bytes keep their order.
- **(g) A process holding an asynchronous child's inherited stream delays its `'exit'`.** The host queues a child's exit only after every stream it captures for that child has closed, so a grandchild still holding one (`(sleep 1; echo late) & ...`) delays the `'exit'` until it closes the stream — indefinitely if it never does (the harness's run timeout bounds it) — where Node emits `'exit'` when the child itself exits.
- **(h) An asynchronous child's stdin given as `"inherit"` is `/dev/null`,** where Node passes its own stdin (under the differential harness a socket at end of file). A child reads end of file either way.
- **(i) Children still running when the program ends are killed by the host** (SIGKILL); Node leaves them running.
- **(j) A descriptor the program did not open is refused as EBADF.** An fd other than 0, 1 and 2 in a `spawn` stdio slot reaches the child only when the program itself opened it; any other makes `spawn` throw "spawn EBADF", where Node hands the child whatever its own process holds at that number (and throws EBADF only when it holds nothing there).

Since INC-28 U3 a child's stdout and stderr can be `"pipe"`: `child.stdout` / `child.stderr` are streams with `'data'` (a Buffer per chunk) and `'end'` listeners. The host reads each pipe with its own `ChildProcess` and attaches its `'data'` listener only when the module's stream gets its first one (`tsinter.cpCall` op 9, FLOW), so the host's stream starts flowing, buffers to its high-water mark and back-pressures the child exactly where the program's own stream would, and the chunks the module emits are Node's own (`tsinter.evPoll` kinds 4 and 5, abi.ts). The module transcribes Node's tick hops itself — `'data'` where the chunk arrives, `'end'` one tick after the end of file, and an unread stream ended by the exit's `flushStdio` → `resume_` → `endReadableNT` chain — and the host marks events its Node emitted in one callback scope so no checkpoint separates them. From a piped child's exit on, the host reads every stream that had no `'data'` listener and forwards those chunks (kind 6), and the module emits or drops each one where Node's `flow()` would — so a listener added in the `'exit'` listener, or in a tick before `flushStdio`'s `resume_` runs, gets the output exactly as in Node. A piped child's `'exit'` is delivered in the order Node emits it among its streams' events. A piped output slot cannot be combined with an inherited or fd output slot in one `spawn`: that shape is refused by name (`cp.spawnOpts:pipeMixed`), since (g)'s held exit would reorder it against the piped stream's events. Two more consequences differ from Node:

- **(k) A `'data'` listener added while the child is still running, after its stream has buffered output, gets that output at the next poll phase.** Node's `on('data')` resumes the stream on a nextTick of the registering callback, so already-buffered chunks are emitted inside that callback's tick drain; here the host's stream resumes only after the module's turn returns, and the chunks arrive at the next poll phase — after the registering callback's own nextTicks and microtasks and after any timers or immediates that run before that poll. A listener added on the turn that spawned the child (the usual shape), or from the child's `'exit'` on, is Node-exact. The chunks, their boundaries and their order are Node's either way.
- **(l) For children that exit close together, one child's `'end'` and another's `'exit'` follow the host's reads.** Node itself orders them by timing: whether a stream's end of file is read before or after its child's exit is processed depends on whether the event loop had polled since the spawn (a program that reaches its loop before its children exit prints `exit 1, end 1, exit 2, end 2`; one whose children exit during its own startup prints `exit 1, exit 2, end 1, end 2`). The host reads the pipes with its own event loop and its own timing, so for fast children (`printf` and exit) it can give either order where a given Node run gives one. Each child's own events keep Node's order, and children that outlive the program's start match Node.

**Scope:** the wasm lane, under a host built on Node's `spawnSync` and `spawn` (the differential harness). The llvm and c lanes start children themselves and differ elsewhere (boards #209 and #213).

**Tested by (asynchronous clauses):** U2-REG-01 (f), U2-REG-02 (g), U2-REG-03 (h), U2-REG-04 and U2-HYG-03 (i), U2-REG-06 (j) in `tests/harness/wasm-differential.test.ts` ("INC-28 U2 child_process async rows"), each asserting this tier's answer with Node's in a comment beside it; U3-LATE-01 (k) and U3-TWO-02 (l: the Node-exact case) in the same file ("INC-28 U3 child output stream rows"), naming Node's order in their titles; (l)'s fast-child cell is timing-dependent and measured, not pinned by a row. Measured against Node v24.18.1.

**Tested by:** U1-RUN-02 and the corpus programs 2362 and 2708 (a: per-stream order), U1-REG-08 (b), U1-REG-10 and U1-RUN-11 (c: the mixed cell and the all-inherited cell), U1-REG-09, U1-REG-12 and U1-REG-13 (d) in `tests/harness/wasm-differential.test.ts`; (e) is timing-dependent and measured, not pinned by a row. Measured against Node v24.18.1.

## S087 — node:net on the wasm lane: errors carry name, message and code only, a multi-address connect tries its addresses one after another with no attempt timer, events across sockets follow the host's reads, a connection the host accepted after the server closed gets a FIN, a connect the host refuses at once fails asynchronously, the checked-dynamic handle's unmodelled surface is fenced by name, a checked-dynamic Buffer's slice and at exist only in net modules, and two libuv pending-queue completions arrive as poll-phase events *(wasm lane only)*

On the wasm lane `net.Server` and `net.Socket` are built in the module, transcribed from Node v24.18.1's `lib/net.js` and the stream state they inherit (validation order and texts, the errno-to-error construction, every nextTick, emit and close-phase position), over OS-level operations the host performs (`tsinter.netCall`, abi.ts) and events it queues (`tsinter.evPoll` source 2). The differential harness's host performs them with Node's own `net` handles, reads on its own event loop, and runs the module's clock in real time while any socket, server or lookup is live. The module runs libuv's own phase order for what the host reports — a shutdown completes in the pending pass after the poll, closed handles run their callbacks last-closed first, and the events the host observed in one of its loop iterations form one poll phase (abi.ts). Ten consequences differ from Node:

- **(a) A net error carries name, message and code only.** A connect, listen, read, write or lookup error has Node's `name`, `message` and `code`; `errno`, `syscall`, `address`, `port` and `hostname` are absent (undefined), and the AggregateError of a multi-address connect (name `"AggregateError"`, empty message, the first attempt's code) has no `errors` array. The same shape as S073, S077 and S085 (b).
- **(b) A multi-address connect tries its addresses one after another, with no attempt timer.** With `autoSelectFamily` (Node's default) a hostname resolving to several addresses is tried in Node's order — the families alternating from the first address's — each attempt waiting for its own answer, where Node abandons an attempt after `autoSelectFamilyAttemptTimeout` (250 ms by default) and starts the next. The two agree whenever each attempt is answered within the budget (a refused or accepted loopback connect); an address that neither accepts nor refuses holds the connect here until the kernel gives up. `setDefaultAutoSelectFamilyAttemptTimeout` and the option are validated with Node's ladders and texts, then have nothing to time.
- **(c) Events on different sockets follow the host's reads.** Each socket's and server's own events keep Node's order, but which of two sockets' events comes first when both are ready at one poll (two clients' data, a client's `'connect'` and the server's `'connection'`) follows the order the host's own event loop read them, not this process's: a Node run of the same program can give the other order (as two Node runs can, since the kernel decides it). Likewise which loop iteration an event lands in is the host's: the events the host read in one of its iterations are one poll phase here, so two events the host read in one iteration and a Node run would read in two (or the reverse) put an immediate queued from the first on the other side of the second.
- **(d) A connection the host accepted after the module closed its server is closed with a FIN.** The host accepts on its own event loop; a connection it accepted before the module's close reached it, and whose event the module then reads for a server that is no longer listening, is closed by the host, so the peer sees the connection close after it was accepted (an end of file, or a reset when its own bytes are unread), and the server emits no `'connection'` for it; under Node the same timing either accepts the connection (its `'connection'` runs) or leaves it in the closed listener's backlog for the kernel to reset.
- **(e) A connect the host refuses at once fails asynchronously, without Node's local-address detail.** Node's `connect` can fail synchronously in libuv (an address the kernel rejects outright) and builds `"connect <CODE> <address>:<port> - Local (<address>:<port>)"`; the harness host reports every connect failure as an event, so the module builds `"connect <CODE> <address>:<port>"`, emitted as Node emits an asynchronous connect failure.
- **(f) The checked-dynamic handle's unmodelled surface is a named Error.** A Socket or Server reached through a dynamic value supports the members this unit models (`on`, `once`, `addListener`, `write`, `end`, `setNoDelay`, `destroy`, `destroySoon`, `pause`, `resume`; `destroyed`, `writable`, `readable`, `bytesWritten`, `remoteAddress`; the server's `on`, `once` and `close`); any other property read, method or event name, `destroy(err)`, `in` and `Object.hasOwn` on one, `Object.assign` onto or from one, its keys, values and entries, inspecting one, `JSON.stringify` of one and `structuredClone` of one throw a catchable Error naming the construct ("… on a net handle is not supported yet"), where Node answers. The fence covers unmodelled ARGUMENTS to modelled members as well: `write` and `end` with an encoding other than `utf8` — including an encoding Node itself rejects, where Node throws `ERR_UNKNOWN_ENCODING` ("Unknown encoding: <name>") — are the same named Error. Every other operation on one (`typeof`, `String()`, a template, truthiness, `===`, `includes` / `indexOf`, `instanceof Error`, `Array.isArray`, a sort or join) answers as Node does.
- **(g) `close(cb)` on a checked-dynamic server that is not listening is a named Error,** where Node hands `cb` an `ERR_SERVER_NOT_RUNNING` error on the `'close'` tick. The statically typed `close(cb)` (whose callback takes no argument) is Node-exact.
- **(h) A connect error or listen error the host cannot name is EIO.** An error the host's Node raises without a negative `errno` reaches the module as `EIO` (-5); Node would surface its own error unchanged. Not observed with real sockets on this host.
- **(i) A checked-dynamic Buffer's `slice` and `at` exist only in modules that use node:net.** The two members are built where a net module needs them (a `'data'` chunk reached through a dynamic value); the same call in a module without node:net is the trap it was before this unit (exit 1, empty stderr), so one program's dynamic `buf.slice()` / `buf.at()` works or traps depending on whether node:net is reachable (board #215). (`slice` of a Buffer that crossed the generic path copies: S037's INC-29 U1 amendment.)
- **(j) Only the shutdown completes in the pending pass; the claim is Linux's.** libuv completes three things through its pending queue that lib/net.js can reach: a shutdown with an empty write queue (modelled: 'finish' lands in the pending pass after the poll, as in Node), a connect the kernel refuses at once (uv__tcp_connect keeps the ECONNREFUSED as a delayed error and feeds the handle), and a write uv_write2 finishes synchronously after a partial try-write (uv__write_req_finish feeds the handle). The last two are not modelled: this tier delivers them as a poll-phase CONNECT or WRITE_DONE event, so on a host whose kernel refuses a loopback connect immediately, or after such a write, an immediate or a poll-phase event of the same iteration lands on the other side of the callback from where Node puts it. On Linux a non-blocking connect answers EINPROGRESS (measured on this host, loopback included), so the first path is never taken; the second needs a partial try-write followed by an immediate full write of the rest, a race the harness does not pin.

**Scope:** the wasm lane, under a host built on Node's `net` (the differential harness). The llvm and c lanes build node:net themselves and differ elsewhere (board #216).

**Tested by:** N1-REG-01 (a) and N1-ERR-03 (the AggregateError's name, message and code), N1-ERR-03 and the corpus program 2599 (b: two loopback addresses in turn; N1-FH-10 and N1-FH-11 in `packages/compiler/test/wasm-host-net-u1.test.ts` script the alternation and the attempt that ends it), N1-MANY-01 (c: written so the cross-socket order is not observed), N1-UNIT-04 (c: the one-iteration-one-poll-phase rule), N1-FH-15 and N1-REG-02 (f), N1-FH-18 (g), N1-UNIT-02 (h), N1-REG-03 and the corpus program 2640 (i, inside a net module) in `tests/harness/wasm-differential.test.ts` unless named otherwise; the modelled half of (j) by N1-PEND-01/02/03 and N1-FH-19/20; (d), (e) and the unmodelled half of (j) need kernel timing or a kernel-rejected address and are measured, not pinned by a row. Measured against Node v24.18.1.

## S088 — node:http on the wasm lane: errors carry name, message and code only, idle connections close in creation order, an agent's TCP keep-alive is not applied, the agent tables read through a dynamic value are snapshots, a request pipes into one destination, the checked-dynamic http handles' unmodelled surface is fenced by name, a null or array the static type does not admit is fenced, a socket's write queue is the host's, and a destroyed client request's socket is awaited on its 'close' *(wasm lane only)*

On the wasm lane node:http is built in the module (`packages/compiler/src/backend/wasm/http.ts`), transcribed from Node v24.18.1's `lib/_http_server.js`, `_http_outgoing.js`, `_http_incoming.js`, `_http_client.js`, `_http_agent.js` and `_http_common.js`, with the C++ parser binding (`src/node_http_parser.cc`: its callbacks, its connections list, the kSkipTaskQueues scopes of the headers-complete and message-complete callbacks and the queue drains after a body chunk and after each consumed read) and llhttp 9.4.3 itself (`deps/llhttp/src/llhttp.c`, converted state for state with its error codes and reasons) built in too. It runs over node:net's sockets (S087) and adds no host operation. Validation order and texts, every nextTick and emit, the framing `_storeHeader` chooses, the Date header's one-second cache and the global agent's defaults (keepAlive, a 5 s timeout) are Node's. These differ:

- **(a) An http error carries name, message and code only.** A parse error is `Error` with message `"Parse Error: <llhttp's reason>"` and code `HPE_*`, with no `bytesParsed`, `reason` or `rawPacket`; a `"socket hang up"` is `ECONNRESET` with nothing more. The same shape as S087 (a).
- **(b) Idle connections are visited in creation order.** `closeIdleConnections`, and the server's own expiry sweep, walk the connections list; Node's is a `std::set` of parser pointers (allocation-address order), this tier's orders the parsers by creation. Two idle connections closed together emit their `'close'` events in creation order here, in Node's address order there (usually the same, not guaranteed).
- **(c) An agent's TCP keep-alive is recorded, not applied.** `keepSocketAlive` calls `socket.setKeepAlive(true, keepAliveMsecs)` as Node does; node:net's host contract has no keep-alive operation, so the socket's kernel option is left alone. Nothing a program reads changes; on a long-idle pooled socket the kernel sends no keep-alive probes.
- **(d) An agent's tables read through a dynamic value are snapshots.** `agent.sockets`, `agent.freeSockets` and `agent.requests` read through a checked-dynamic Agent are a fresh null-prototype object per read, holding arrays of the handles: their contents are Node's at the moment of the read, but two reads are different objects (`agent.sockets === agent.sockets` is false; Node: true) and a write to one does not reach the agent.
- **(e) An IncomingMessage pipes into one destination.** A second `pipe()` from the same request or response throws a named Error ("piping an IncomingMessage into a second destination is not supported yet"); Node pipes into both.
- **(f) The checked-dynamic http handles' unmodelled surface is a named Error.** An IncomingMessage, ServerResponse, ClientRequest or Agent reached through a dynamic value supports the members the corpus reaches — the request's `method`, `url` (also written), `statusCode`, `statusMessage`, `headers`, `rawHeaders`, `httpVersion` and its two parts, `complete`, `aborted`, `readable`, `destroyed`, `readableEnded`, `req`, `on` / `once` / `addListener` / `prependListener` for `data`, `end`, `close`, `error` and `aborted`, `pause`, `resume`, `pipe` (into a response or a client request) and `destroy()`; the response's `statusCode` and `statusMessage` (both also written), the response's and client request's `headersSent`, `writableEnded`, `finished`, `writableFinished`, `writableCorked`, `writableLength`, `writableNeedDrain`, `destroyed`, `req`, the client request's `method`, `path`, `host`, `protocol` and `reusedSocket`, the listener methods for `close`, `finish`, `error`, `drain`, `timeout` (and the client request's `response`), `setHeader`, `appendHeader`, `getHeader`, `getHeaders`, `getHeaderNames`, `hasHeader`, `removeHeader`, `writeHead` (a reason, a headers object or a flat array), `write` and `end` (a string or Buffer, an encoding Buffer knows, a callback), `cork`, `uncork`, `flushHeaders` and `destroy()`; the Agent's `maxSockets`, `maxFreeSockets`, `maxTotalSockets`, `totalSocketCount`, `keepAlive`, `keepAliveMsecs`, `defaultPort` (the numeric ones and keepAlive also written), `protocol`, `scheduling`, the three tables (d), `getName` and `destroy`. Any other property read or write, method or event, `destroy(err)`, a header value that is not a string, a number or an array of them, `writeHead` with an array of `[name, value]` pairs, and an encoding outside Buffer's own throw a catchable Error naming the construct ("… on an http handle is not supported yet", or S087 (f)'s "… on a net handle is not supported yet" for the generic operations S087 (f) lists — `in`, `Object.hasOwn`, `Object.assign`, keys, inspection, `JSON.stringify`, `structuredClone`), where Node answers.
- **(g) A null or array the static type does not admit is fenced.** On the statically typed surface `req.method` of a client response, `req.statusCode` and `req.statusMessage` of a server request (all null in Node), `res.statusMessage` before it is set or written (undefined), a `set-cookie` header read as a string or spread into a record (an array in Node), a header set to an array read back through the typed `getHeader`, and `res.socket` of a response whose socket went back to its agent (null) throw a named Error instead of answering a value the static type says cannot occur. Through a dynamic value the same reads are Node's.
- **(h) RETIRED (INC-29 follow-up unit, the http option carry).** Five options the lowering lost now reach every backend with Node's values: `requireHostHeader` in `createServer`'s options; an Agent's `scheduling` (validated, read back, and choosing the free socket); a negative `keepAliveMsecs`, `maxSockets`, `maxFreeSockets`, `timeout` or `port` on an Agent (kept, as Node's `|| default` keeps it); a request's `timeout: 0` (it clears the agent's socket timeout); and `agent: false` with a Connection header (its own one-shot Agent). Pinned by corpus 2743 and 2744 and rows N2-OPT-01 and N2-OPT-02.
- **(i) RETIRED (the same unit).** On the statically typed ServerResponse `setHeader(name, n)` keeps the number (`getHeader` answers it), and `writeHead(status, reason, …)` checks the status code before it takes the reason, as Node does. Pinned by corpus 2743 and row N2-REG-03.
- **(j) A socket's write queue is the host's.** A socket's inactivity timer (`setTimeout`, which http's server and agent arm) is not refreshed by a fire while a write is outstanding: Node reads libuv's `writeQueueSize`, the bytes the kernel has not yet taken; this tier reads the bytes of the write the host has not yet reported done. The two agree whenever the kernel takes a write at once (every write the corpus makes); a timeout that fires during a write the kernel holds back can be refreshed on one side and not the other.
- **(k) A destroyed client request's socket is awaited on its `'close'`.** When a ClientRequest is destroyed before it has a socket and the socket it then gets is destroyed rather than returned to its agent, Node's `onSocket` waits with `stream.finished(socket.destroy(err))`; this tier waits for the socket's `'close'` event. `finished` calls back on that same `'close'` for a socket destroyed this way, so the order is Node's; the clause records that `finished`'s other paths (a stream already closed, or one that errors before closing) are not modelled.

**Scope:** the wasm lane, under a host built on Node's `net` (the differential harness). The llvm and c lanes build node:http themselves and are not changed by this entry.

**Tested by:** N2-REG-01 (d, e, f) and N2-REG-03 (g) in `tests/harness/wasm-differential.test.ts`, with Node's answers in comments beside them; the corpus programs 1750, 1780, 1781, 1795, 1796, 1798, 2638, 2639, 2641, 2642, 2714, 2743 and 2744 (the modelled surface, Node-exact); (a), (b), (c), (j) and (k) are measured, not pinned by a row. Measured against Node v24.18.1.

## S089 — the WHATWG URL on the wasm lane: errors carry name, message and code only, any dynamic value other than a primitive or a plain object is fenced by name as a URLSearchParams name or value, and (on every lane) a record argument converts through its toString member alone and a checked-dynamic non-string URL input throws *(wasm lane; (c) and (d) all lanes)*

On the wasm lane `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL` and the http client's URL argument are built in the module (`packages/compiler/src/backend/wasm/url-whatwg.ts`, `url-idna.ts`, `url-tables.ts`), transcribed from Node v24.18.1's vendored ada 3.4.4 (`deps/ada`: the parser, host parsing with IPv4 / IPv6 / opaque hosts, the percent-encode sets, path parsing, serialization, and its IDNA — UTS #46 mapping, NFC, punycode, the bidi and ContextJ checks — with ada's tables as data), `lib/internal/url.js` (the getters, URLSearchParams and its urlencoded parser and serializer, the live `searchParams` view, `fileURLToPath`), `src/node_url.cc` (`pathToFileURL`'s path encoding) and `lib/_http_client.js` (`urlToHttpOptions` and the protocol check). No host operation is added. Results, error classes, codes and messages are Node's, measured over the web-platform-tests URL and IDNA inputs. These differ:

- **(a) An error carries name, message and code only.** `ERR_INVALID_URL` has no `input` (or `base`) property and `ERR_INVALID_FILE_URL_PATH` no `input`; inspecting one shows S021's encoding. The same shape as S087 (a) and S088 (a).
- **(b) Some dynamic values are fenced as a URLSearchParams name or value.** A checked-dynamic argument converts with Node's ToPrimitive (string hint) when it is a primitive or a plain object: an own callable `toString` is called with the object as `this`, then an own `valueOf`, a throw propagates, and neither giving a primitive is Node's `TypeError: Cannot convert object to primitive value`; an object with no own `toString` answers `"[object Object]"`. Any other dynamic value — an array, a function, a Buffer, a handle, a promise, or any other non-plain kind the checked-dynamic tree carries — throws a catchable Error ("converting this dynamic value to a URLSearchParams string is not supported yet") where Node converts it.
- **(c) A statically typed record argument converts through its `toString` member alone (every lane).** The front end boxes only the record's `toString` member for the conversion, so a record whose `toString` returns an object and whose `valueOf` returns a primitive throws `TypeError: Cannot convert object to primitive value` where Node uses `valueOf`. The llvm and c lanes do the same (the IR carries no `valueOf`). Board #217.
- **(d) A checked-dynamic URL input that is not a string throws (every lane).** `new URL(input, base?)`, `URL.parse` and `URL.canParse` take the one-argument constructor's input route: a checked-dynamic input is checked as a string, so a number or an object throws the checked conversion's `TypeError` ("expected string, got number") where Node converts it with `${input}` — `URL.canParse(5)` throws here, Node answers `false`. A base is converted as Node converts it (a checked-dynamic base with (b)'s converter).

Not divergences, recorded for the reader: `new URL(input, base)`, `URL.parse(input, base?)` and `URL.canParse(input, base?)` resolve against the base as Node does (ada's NO_SCHEME, SPECIAL_RELATIVE_OR_AUTHORITY, RELATIVE_SCHEME and RELATIVE_SLASH states and its FILE / FILE_SLASH base arms, transcribed in a parser separate from the base-less one, including ada's own fall-through for an opaque-path base with an input that is more than a fragment — `new URL("x#f", "mailto:a")` is `mailto:a/x#f`); the native lanes do not resolve a base (S096); `sort()` is Node's own algorithm (a stable insertion sort below 100 list entries, a stable bottom-up merge sort from 100); a `searchParams` mutation writes the URL's query at once, where Node writes it on the URL's next read (no read can tell).

**Scope:** (a) and (b) the wasm lane; (c) and (d) every lane.

**Tested by:** `packages/compiler/test/wasm-url-u3.test.ts` (the parse, IDNA, URLSearchParams and file-URL matrices against Node in-process; URL-BASE-01..05 the web-platform-tests [input, base] pairs, a hand-written base matrix and the argument routes) and the "INC-29 U3 WHATWG URL rows" and "URL base rows" blocks of `tests/harness/wasm-differential.test.ts` (the twelve corpus programs and the http client's URL argument); URL-REG-01 (a) and URL-REG-02 (b) in `wasm-url-u3.test.ts` pin this tier's answers with Node's in their titles; (c) and (d) are measured, not pinned by a row. Measured against Node v24.18.1.

## S090 — node:tls, node:https and node:dgram on the wasm lane: errors carry name, message and code only, the TLS engine's own failures carry the host engine's text, a few PEM forms and certificate fields are fenced by name, the CA store's arrays are not frozen and its defaults are the host's, the handshake timeout is not armed, sessions are not resumed, a rejecting client's Finished reaches the server, a secured socket's plaintext is read ahead and a late TLS failure destroys it, a tls.Server has no separate raw socket, and the options this tier does not carry are fenced by name *(wasm lane only)*

On the wasm lane node:tls, node:https and node:dgram are built in the module (`packages/compiler/src/backend/wasm/tls.ts`, `tls-x509.ts`, `tls-roots.ts`, `dgram.ts`), transcribed from Node v24.18.1's `lib/internal/tls/wrap.js`, `lib/tls.js`, `lib/internal/tls/secure-context.js`, `lib/internal/tls/common.js`, `lib/https.js`, `lib/_http_agent.js`, `lib/dgram.js` and `lib/internal/dgram.js`, with `src/crypto/crypto_context.cc` (the CA store: X509_cmp's order, LoadCertsFromBIO), `crypto_common.cc` (the verification reason and its `--use-system-ca` suggestion), ncrypto's subjectAltName printing and OpenSSL 3.5.7's PEM reader (`crypto/pem/pem_lib.c`, `crypto/evp/encode.c`) built in. The TLS ENGINE is the host's (`tsinter.tlsCall`, abi.ts): it builds a context from the bytes the module hands it, secures an open net socket, and reports the handshake's completion with the X.509 verification code of the peer's chain and the peer's leaf certificate as DER; the module maps the code to Node's code and text, runs `tls.checkServerIdentity` over the DER, and runs every TLSSocket and https event as Node does. UDP is four OS-level operations on `tsinter.netCall` (ops 20-23). Node's bundled root store (120 certificates) is data in the modules that read the store (`getCACertificates`, `rootCertificates`). The differential harness's host is Node's own `tls` and `dgram`. These differ:

A secured socket and a dgram socket are net-lane handles for event ordering: S087 (c) applies unchanged, so which of two sockets' events comes first when both are ready at one poll (a client's `'end'` and the server's `'close'`, datagrams arriving on two different sockets; sends still leave in call order) follows the host's reads; each socket's own events keep Node's order.

- **(a) An error carries name, message and code only.** A verification error (`DEPTH_ZERO_SELF_SIGNED_CERT`, ...), `ERR_TLS_CERT_ALTNAME_INVALID` (no `reason`, `host` or `cert`), an engine error (no `library` or `reason`), a dgram `ExceptionWithHostPort` (no `errno`, `syscall`, `address` or `port`). The same shape as S087 (a).
- **(b) The engine's own failures carry the host engine's text.** A TLS protocol failure (`ERR_SSL_*`, reported as the host's TLS_ERROR event) and a context material failure (a certificate or key that does not parse, a key that does not match: `ERR_OSSL_*`, thrown by `createServer` / `createSecureContext`) carry the message and code the host's engine gives. The harness host is Node's own OpenSSL, so they are Node's there; a host on another engine (mbedTLS) gives its own. Verification codes are OpenSSL's numbers, which the module maps to Node's codes and texts; a host on another engine maps its own verdict to those numbers (abi.ts lists mbedTLS's), and where it cannot tell OpenSSL's cases apart, or reports a different first error of a chain, the code and text differ from Node's. The wasm-native lane's host is Node's own OpenSSL (S117 (g)), so its verdicts, its protocol failures and its material failures are Node's (an OpenSSL error line's leading thread id is the process's own).
- **(c) Some PEM forms are fenced.** `setDefaultCACertificates` reads PEM as OpenSSL does (names, stray text, CRLF, a BOM, base64 errors, a bad end line, `X509 CERTIFICATE`, skipped blocks of other names, all Node's), except a block with PEM header lines (a `:` line, or a blank line before the end line) and a line of over 253 bytes (which OpenSSL reads in pieces): both are a named Error ("tls.setDefaultCACertificates of a PEM block with header lines or a line over 253 bytes is not supported yet"), where Node answers PEM_R_NOT_PROC_TYPE's error or parses the long line. A block that decodes to no bytes ends the read, as OpenSSL's does. A certificate is read at its outer DER structure (SEQUENCE of tbsCertificate, signatureAlgorithm, BIT STRING) and the tbsCertificate's fields by tag (version, serial, signature, issuer, two times, subject, subjectPublicKeyInfo, the optional [1], [2], [3]): one OpenSSL rejects deeper inside (an OID's or a time's contents, an extension) is accepted here and fails when a handshake uses it. A non-minimal or indefinite outer length is re-encoded as OpenSSL's i2d does; a non-minimal or indefinite length in the signatureAlgorithm or signature, or an indefinite one in the tbsCertificate, which OpenSSL would also re-encode or accept, is a named Error ("tls.setDefaultCACertificates of a certificate whose DER OpenSSL would re-encode (a non-minimal or indefinite length inside it) is not supported yet").
- **(d) The CA store's arrays are not frozen; its defaults are the host's.** `getCACertificates` answers Node's strings and Node's caching, but the arrays can be written (Node freezes them). `'system'` and `'extra'` are the host's (the harness host answers its Node's); `'default'` is the bundled roots alone (Node adds `NODE_EXTRA_CA_CERTS`'s certificates, and with `--use-system-ca` the system's), so a module that reads only `'bundled'`, `'default'` or `rootCertificates` needs no TLS host; a client that has not replaced the store asks the host for its default trust, which carries the extra certificates.
- **(e) The handshake timeout is not armed.** `handshakeTimeout` is validated as Node does and has no timer: a peer that stalls a server's handshake is waited for, where Node emits `ERR_TLS_HANDSHAKE_TIMEOUT` after 120 s.
- **(f) Sessions are not resumed.** `isSessionReused()` is false, so `checkServerIdentity` runs on every connection (Node skips it for a resumed session); an https Agent keeps no session cache; `ticketKeys`, `sessionTimeout` and `sessionIdContext` are validated and inert; a `'session'` listener does not lower.
- **(g) A secured socket's plaintext is read ahead, and a TLS failure after the handshake destroys the socket.** The host reads a secured socket for its handshake whatever the module's read state and holds the plaintext until the module reads (Node's TLSSocket stops reading at its high-water mark). The handshake's completion and the first plaintext of the same read arrive as two events with a microtask checkpoint between them. A TLS protocol error after the handshake destroys the socket with that error (Node emits it and leaves the socket).
- **(h) A rejecting client's handshake Finished reaches the server.** A client that rejects the server's certificate decides after its host engine completed its side of the handshake, so with TLS 1.3 the server's handshake completes too (its `'secureConnection'` runs, then the client closes); under Node the client destroys the socket before its Finished leaves and the server's handshake never completes. No application data reaches such a server: what the client wrote before its verdict is held in the module and dropped, so an https server sees a connection and no request. The wasm-native lane does not share (h): its host holds the flight that completes a client's handshake until the module has run its listeners (as Node's TLSWrap writes it only after them, native-runner N2a, board #336), and a rejecting client destroys the socket before its Finished leaves, as under Node (a listener that writes first sends the Finished with that write, as Node does; one that only destroys sends neither). On every lane the module releases a write it held for the verdict BEFORE emitting `'secureConnect'`, and a write in that listener goes straight to the host, so a `destroy()` later in the listener leaves it sent, as under Node.
- **(i) A tls.Server has no separate raw socket.** Node's `'connection'` event carries the raw TCP socket, then a TLSSocket wraps it; here one socket is both, and `server.on('connection')` on a TLS server is a named Error ("a 'connection' listener on a tls.Server is not supported yet").
- **(j) Options this tier does not carry are fenced by name.** Every option is validated with Node's ladder and text first; then an option whose effect is not modelled is a named Error at the point Node would use it ("tls.createServer option 'ciphers' is not supported yet"): non-default `minVersion` / `maxVersion`, `secureProtocol`, `ciphers`, `sigalgs`, a non-`auto` `ecdhCurve`, `dhparam`, `crl`, `pfx`, a `passphrase`, key objects, more than one cert or key, engines, `allowPartialTrustChain`, a non-zero `secureOptions`, `requestCert: true`, ALPN, SNI and PSK callbacks, and the net-level members (`allowHalfOpen`, `pauseOnConnect`, `noDelay`, `keepAlive`, `highWaterMark`, ...); on `tls.connect` a `checkServerIdentity` function, `secureContext`, `session`, `socket`, `timeout`, a string port, an IP or non-string `servername` (Node warns DEP0123 or throws after the connect has started), and the net connect options. `NODE_TLS_REJECT_UNAUTHORIZED` is not consulted. `tls.checkServerIdentity` reads host names of ASCII letters, digits, `-`, `_` and `.`, and IP literals (an IPv6 literal is not a domain to Node's `domainToASCII`, so it is matched against DNS names and fails, as Node's does); other host names, `xn--` labels and IPv4 shorthands are a named Error; and a certificate whose alt names Node would quote, or that carries an othername, DirName, Registered ID, X400 or EdiParty alt name, or a CN of another string kind, is a named Error. The https server advertises no ALPN (Node's offers `http/1.1`); an https request's explicit `rejectUnauthorized: true` shares an Agent pool with the default (Node keys them apart). dgram: a host NAME as an address (a dns.lookup), a bind port outside 0..65535, send callbacks and buffer lists are named Errors; `udp6` does not lower.

**Scope:** the wasm lane, under a host built on Node's `tls` and `dgram` (the differential harness). The llvm and c lanes build these modules on mbedTLS and their own sockets and are not changed by this entry.

**Tested by:** the "INC-29 U4 node:tls, node:https and node:dgram rows" block of `tests/harness/wasm-differential.test.ts` (the seven corpus programs; U4-VERIFY-01 the verification codes, texts and the altnames reason; U4-TLS-01 tls.connect; U4-TLS-02 (b); U4-DGRAM-01; U4-REG-01 (h); U4-HOST-01 the declined import and the store-only module that needs none; the U4-R rows from the unit's review: writes held until the verdict, an IPv6 host, options in a variable, a runtime empty `ca`, UDP send order, the verification suffix, the empty-decoding PEM block, non-canonical DER) and `packages/compiler/test/wasm-tls-u4.test.ts` (the bundled roots, the PEM matrix against Node, U4-REG-02 (c)); (a), (d), (e), (f), (g), (i) and (j) are measured, not pinned by a row. Measured against Node v24.18.1.

## S091 — record own keys: an OPTIONAL field holding `undefined` is not an own key to the key surfaces, even when the program wrote `undefined` to it explicitly, while printing and the dynamic conversion keep every field but a units-only optional one; structurally identical record types share one answer, and a record shape built by a checked conversion treats its undefined-armed fields as optional *(llvm, c and wasm)*

A record value has no per-key presence bit: a field slot always exists and holds a value. Which fields
are own keys is decided from the shape (`IrRecordShape.fields[].optional`, the `?` of the declaring
type), by two rules:

- The KEY surfaces — `Object.keys` / `values` / `entries`, `for...in`, `in`, `Object.hasOwn` and
  `Object.assign` between records: a field declared WITHOUT `?` is an own key whatever it holds
  (`undefined` and `void` fields included); a field declared WITH `?` is an own key exactly while it does
  not hold `undefined`.
- PRINTING (`util.inspect`, `console.log`) and the conversion to a checked-dynamic value (what
  `Object.assign({}, ...srcs)`, `querystring.stringify` on the native lanes and every dyn reader see):
  every field is present, except an optional field whose type is ONLY `undefined`/`null` — TypeScript's
  phantom `b?: undefined` members of a widened literal like `[{ a: 1 }, { b: 2 }]` (board #230) — which is
  absent while it holds `undefined`.

`JSON.stringify` drops `undefined` values either way and is unaffected. Both rules are Node's answer for
the common cases: required fields, optional fields the program set, optional fields the program left out
(key surfaces), an optional field explicitly set to `undefined` (printing and the dyn crossing), and the
widened-literal phantoms (everywhere). They diverge in four cells, each measured against Node v24.18.1:

(a) an optional field the program EXPLICITLY set to `undefined`, at the key surfaces: `const p: { a:
number; w?: number } = { a: 1, w: undefined }` — Node `console.log(p, Object.keys(p), "w" in p)` prints
`{ a: 1, w: undefined } [ 'a', 'w' ] true`; every tsinter lane prints `{ a: 1, w: undefined } [ 'a' ]
false`.

(b) a REQUIRED field holding `undefined` whose shape is shared with an identical type that declares the
same field optional: record identity is the field list (names and types), not the `?`, so `{ a: number;
w: number | undefined }` and `{ a: number; w?: number }` are one shape, and the `?` of either makes the
field optional for both (`optional` ORs across them). `const e: { a: number; w: number | undefined } =
{ a: 1, w: undefined }` alone answers Node's `a,w`; in a module that also declares
`{ a: number; w?: number }` it answers `a`.

(c) a REQUIRED field of a shape that a checked conversion builds — a dynamic or island value checked into
a record (`JSON.parse(s) as T`, an `unknown` argument narrowed by `as`, a JavaScript value crossing into
a typed slot), at any nesting depth: the source may simply lack the key, so every undefined-armed field
of such a shape counts as optional module-wide, which makes a required field holding an EXPLICIT
`undefined` lose its key at the key surfaces the way (a) does. `type A = { a: number | undefined; b:
number }` with `const x: A = JSON.parse('{"b":1}') as A` answers Node's `[ 'b' ] false`; in the same
module `const y: A = { a: undefined, b: 2 }` answers `[ 'b' ]` where Node answers `[ 'a', 'b' ]`.

(d) printing and the dyn crossing of an optional field that is ABSENT — left out by the program, or
missing from the source of a checked conversion — when its type holds more than units: `const o: { a:
number; w?: number } = { a: 1 }; console.log(o)` prints `{ a: 1, w: undefined }` where Node prints
`{ a: 1 }`, and the `x` of (c) prints `{ a: undefined, b: 1 }` where Node prints `{ b: 1 }`. (This was
the behaviour before board #178 too.)

**Rationale:** telling (a) and (d) apart needs a presence bit per optional slot that every record write,
copy and reader maintains — absent and explicitly-undefined are the same slot value, so each surface
must pick one reading: the key surfaces read "absent" (the left-out field is the common case there) and
printing and the dyn crossing read "present" (a program that writes `undefined` into an optional field
usually means it to show, `querystring.stringify`'s `u=` being the corpus case), except where the field
can hold nothing else; splitting shapes on `?` to close (b) would make two TypeScript-compatible types two
distinct structs, so every assignment between them would copy and lose aliasing (an observable
divergence of its own, on far more programs); (c) keeps a record that came from a key-less source
answering Node's keys, at the cost of the explicit-undefined case on the same shape. The `?`-driven rule
is exact for every program that does not write `undefined` into a field that is optional or checked.

**Tested by:** `packages/compiler/test/wasm-silent-batch.test.ts` (PRESENCE rows: the required, optional,
widened-literal, index-signature and checked-conversion cells with Node's answers, and the divergent
cells pinned with Node's output beside them); the llvm and c lanes are measured, not pinned.

## S092 — node:diagnostics_channel and AsyncLocalStorage on the wasm lane: ReflectApply's TypeError text is rendered for primitives, plain objects and arrays only, tracePromise fences a non-promise without subscribers and a non-promise thenable, setImmediate as a function value answers undefined and calls its callback with `this` undefined, and channels are never collected *(wasm lane only)*

On the wasm lane `diagnostics_channel` (channels, `subscribe` / `unsubscribe` / `publish`, `bindStore` / `unbindStore` / `runStores`, tracing channels with `traceSync`, `traceCallback` and `tracePromise`) and `AsyncLocalStorage` (`run`, `exit`, `getStore`, `enterWith`, `disable`) are built in the module (`packages/compiler/src/backend/wasm/dc.ts`), transcribed from Node v24.18.1's `lib/diagnostics_channel.js`, `lib/internal/async_local_storage/async_context_frame.js` and `lib/internal/async_context_frame.js` (v24 runs AsyncContextFrame by default). No host operation is added. The ActiveChannel prototype swap, the copy-on-write subscriber list, the wrapStoreRun chain (the last-bound store outermost, a throwing transform skipped), a subscriber's or transform's throw re-raised from a nextTick job (`triggerUncaughtException`, rendered as S007 says), `run`'s ObjectIs shortcut and its restore through `enterWith(prior)`, and the frame carried by every promise job, timer, interval, immediate and nextTick callback (captured when it is scheduled) are Node's. These differ:

- **(a) ReflectApply's TypeError text is rendered for some values only.** Calling a non-function through `run`, `exit`, `runStores` or a trace call throws V8's `Function.prototype.apply was called on <value>, which is <kind> and not a function` for undefined, null, booleans, numbers, strings, plain objects (`#<Object>`) and arrays (`[object Array]`). Any other non-function dynamic value (a Buffer, an error object, a null-prototype object, a Map stand-in, a promise, a handle) throws a catchable Error ("calling a non-function value of this kind through diagnostics_channel or AsyncLocalStorage is not supported yet").
- **(b) tracePromise fences two returns.** With no subscribers, a traced function returning a non-promise throws a catchable Error ("tracePromise without subscribers over a function returning a non-promise is not supported yet") where Node returns the value itself (the IR types the call as a promise). With subscribers, a traced function returning an object with a callable `then` throws a catchable Error ("tracePromise over a function returning a non-promise thenable is not supported yet") where Node adopts the thenable.
- **(c) setImmediate as a function value** (`traceCallback(setImmediate, …)`) validates its callback and schedules it as Node does, but answers undefined where Node returns an Immediate, and calls the callback with `this` undefined where Node passes the Immediate.
- **(d) Channels are never garbage-collected.** Node keeps channels in a WeakRefMap: a channel nothing references can be collected, after which `hasSubscribers(name)` answers false and `channel(name)` makes a new object. Here every channel lives for the whole run; in Node the difference shows only through garbage-collection timing.
- **(e) The re-raise of a throwing subscriber or transform rides this tier's nextTick queue**, so S082's ordering applies to it: microtasks already queued run before the uncaught error ends the program, where a CommonJS Node runs the tick first.

Not divergences, recorded for the reader: a module that reaches AsyncLocalStorage REFUSES (compile time, `libCall:als:context-through-<family>`) node:net, http, https, http2, tls, dgram, dns, streams, child processes, readline and stdin, fs.watch and fs.exists, node:test and the process signal / exit / warning / rejection listeners, because the callbacks those deliver would not carry the frame; `new Promise(setImmediate)` fulfils with the executor's reject function as Node does (an anonymous native function); `traceCallback` over a traced function with a function-typed parameter declaring fewer than two parameters refuses by name on every lane (TypeScript infers that parameter from the trailing callback, e.g. `() => {}`, and the traced function's `cb(err, value)` call would otherwise lose its arguments).

**Scope:** the wasm lane.

**Tested by:** the "Unit B diagnostics_channel and AsyncLocalStorage rows" block of `tests/harness/wasm-differential.test.ts`: the five corpus programs (2094, 2160, 2211, 2213, 2214), DCALS-01 to DCALS-06 against Node's output, DCALS-F1 pinning (a) to (c) with Node's answers in its title, DCALS-R1 the refusal; (d) is not pinned by a row. Measured against Node v24.18.1.

## S093 — node:crypto on the wasm lane: errors carry name, message and code only, randomness is the host's entropy, an X509Certificate is read at its outer DER structure, and a few PEM forms and validity times are fenced by name *(wasm lane only)*

On the wasm lane the lowered node:crypto keys are computed in the module (`packages/compiler/src/backend/wasm/crypto.ts`): `randomUUID`, `randomBytes(n)` and the composed `randomBytes(n).toString("hex" | "base64")`; the composed `createHash("sha256" | "sha1").update(data).digest("hex" | "base64")` (SHA-256 per FIPS 180-4, SHA-1 from `tls-x509.ts`, strings hashed as their UTF-8 bytes); and the composed `new X509Certificate(data).fingerprint` / `.validFrom` / `.validTo`, transcribed from ncrypto's `X509Pointer::Parse` (OpenSSL 3.5.7's `PEM_read_bio_X509_AUX` over the bytes, through U4's PEM reader in a first-certificate mode, then `d2i_X509_bio` over the raw bytes), `X509_digest` and `ASN1_TIME_print`. `randomBytes`' size ladder (Node's `ERR_OUT_OF_RANGE` with its numeric-separator rendering) and the PEM errors (`no start line`, `bad base64 decode`, `bad end line`, with their `ERR_OSSL_PEM_*` codes) are Node's. These differ:

- **(a) An error carries name, message and code only.** The PEM errors have no `library` or `reason` (Node's have both); the same shape as S090 (a).
- **(b) Randomness is the host's entropy.** The bytes come from `tsinter.random` (abi.ts), an OS entropy read the host services (getrandom(2), arc4random_buf, crypto.getRandomValues). Their quality is the host's, as `seed`'s is for S068; Node's come from OpenSSL's CSPRNG. Values are never compared differentially, only their shape.
- **(c) A certificate is read at its outer DER structure.** As S090 (c): a certificate OpenSSL's `d2i_X509` rejects deeper inside (an OID's or a time's contents, an extension) is accepted here. On the PEM path such a failure is the ASN.1 decoder's own error in Node; here a PEM block whose body is not a certificate at this outer level is a named Error (below) rather than Node's ASN.1 text, and on the raw-DER path it is Node's `no start line`, as Node's is.
- **(d) A few PEM forms and validity times are fenced by name.** Each is a catchable `Error` whose message names the construct and ends "is not supported yet (SEMANTICS.md S093)": a PEM block whose body is not a certificate's DER (Node: the ASN.1 decoder's reason, e.g. `header too long`); a block with header lines, a line over 253 bytes or an empty body (as S090 (c)); a certificate whose DER OpenSSL would re-encode (as S090 (c)); bytes after the certificate inside the block, which `d2i_X509_AUX` reads as `X509_CERT_AUX` trust data (a `TRUSTED CERTIFICATE` block without them is read, as Node reads it); and a validity time other than a canonical RFC 5280 UTCTime (`YYMMDDHHMMSSZ`, 50-99 as 19xx) or GeneralizedTime (`YYYYMMDDHHMMSSZ`) with every field in range (Node prints other forms, fractions and offsets included, or "Bad time value").
- **(e) Sizes past the engine.** `randomBytes(n)` for a size the engine cannot allocate as one array is an uncatchable trap (V8: "requested new array is too large" at 2^31 - 1 bytes), where Node allocates it; hashing a single input of 512 MiB or more is outside the SHA-1 length counter (which holds 2^29 bytes).

**Scope:** the wasm lane. The llvm and c lanes run `scr_lib.c`'s own crypto slice and are not changed by this entry.

**Tested by:** 957, 1358, 1534, 1568, 2280 and 2722 on the wasm census; the "node:crypto core rows" block of `tests/harness/wasm-differential.test.ts` (CR-HASH-01 the padding boundaries and input forms, CR-RAND-01 the size ladder and the randomness shape, CR-X509-01 the parse forms and PEM errors against Node, CR-X509-02 the fences of (d) on their own text, CR-HOST-01 the import's presence). (a), (b) and (e) are measured, not pinned. Measured against Node v24.18.1.

## S094 — Atomics.wait over a SharedArrayBuffer-backed field rebound at run time is not re-checked, the native lanes' Atomics.wait index and timeout edges differ, and `new Buffer(value, encoding)` over a string or object value is fenced by name on the wasm lane *((a) llvm, c and wasm; (b) llvm and c; (c) wasm lane only)*

`Atomics.wait(int32Array, index, expected, timeout)` lowers only when the source shows the array is backed by a SharedArrayBuffer: the expression `new Int32Array(new SharedArrayBuffer(n))` itself, or a read of a `const` or a `static readonly` class field initialized with it. Every other array refuses at compile time by name ("Atomics.wait over an Int32Array not visibly backed by a SharedArrayBuffer"), because Node throws `TypeError: [object Int32Array] is not a shared typed array.` for an unshared one and the lowered value cannot tell the two apart (the buffer is erased at construction). On the wasm lane the wait runs Node's index check (a catchable `RangeError` "Invalid atomic access index" after ToIndex), ToInt32 of `expected` and the timeout rule (NaN waits forever, a negative timeout is 0). It then answers `"not-equal"` at once, or sleeps through the host's `sleep` import (abi.ts) and answers `"timed-out"`. No thread can ever notify, so `"ok"` cannot happen; the same holds for Node's main thread with no workers. The checked-dynamic `new Buffer(value, encoding)` answers Node's TypeErrors for a number (the string arm) and for undefined, null, a boolean and a function (Buffer.from's "first argument" error). These differ:

- **(a) A static readonly field rebound at run time.** TypeScript admits a write to a `static readonly` field inside the class's static block, and an `any` cast admits one anywhere. A field initialized with a shared array and then rebound to an unshared one is still admitted, and the wait sleeps where Node throws TypeError. A `const` cannot be rebound.
- **(b) The native lanes' edges.** The llvm and c lanes trap on an out-of-range index (Node: the catchable RangeError) and treat a NaN timeout as 0 (Node: wait forever).
- **(c) A string or object value is fenced.** `new Buffer(value, encoding)` lowers here when `value` is not typed as a string. At run time Node sends any value other than a number through `Buffer.from(value, encoding)`. That converts a string, an array or an array-like object (an own `length`, a `{ type: "Buffer", data }` record, an object whose `valueOf` answers a string or an object). It throws the same "first argument" TypeError for any other object ("Received an instance of Object", "... of Map"). This libCall does not carry the encoding and does not inspect an object's members, so on the wasm lane every string, array, object or Buffer value throws a catchable `Error` "new Buffer(value, encoding) over a string or object value is not supported yet (SEMANTICS.md S094)". The native lanes throw the number arm's TypeError for every value.

**Scope:** (a) every lane; (b) the llvm and c lanes; (c) the wasm lane.

**Tested by:** 1524 and 2570 on the wasm census; the "unit H small library tail rows" block of `tests/harness/wasm-differential.test.ts` (H-AW-01 the argument handling against Node, H-AW-03 the compile-time refusals and the admitted forms, H-BUF-02 and H-BUF-04 the TypeErrors against Node, H-BUF-03 the fence of (c)). (a) and (b) are measured, not pinned. Measured against Node v24.18.1.

## S095 — a timer delay that is negative, NaN or past 2^31 - 1 is clamped to 1 ms without Node's TimeoutNegativeWarning / TimeoutNaNWarning / TimeoutOverflowWarning *(llvm, c and wasm)*

Node coerces a `setTimeout` / `setInterval` delay, and the delay of `node:timers/promises`' `setTimeout`, to 1 ms when it is not in [1, 2^31 - 1]. A negative delay, a NaN delay and an overflowing one each also emit a process warning on stderr: `(node:<pid>) TimeoutNegativeWarning: -5 is a negative number.`, `TimeoutNaNWarning: NaN is not a number.` and `TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed integer.`, each followed by `Timeout duration was set to 1.` and, the first time, Node's `--trace-warnings` hint. Every tsinter lane applies the same clamp, in the same order, and prints nothing. A delay below 1 that is not negative (0, 0.5) clamps silently in Node too.

**Scope:** every lane, the callback timers and timers/promises alike.

**Tested by:** measured, not pinned. H-TP-01 in `tests/harness/wasm-differential.test.ts` uses only the silent clamps (0 and 0.5). Measured against Node v24.18.1.

## S096 — `new URL(input, base)`, `URL.parse` and `URL.canParse`: the WASM tier answers as Node does; the NATIVE lanes check a base, then throw an `Error`, and throw an `Error` for `URL.parse` / `URL.canParse` outright *(per-lane split)*

On `new URL("x", "http://h/a/")`: Node answers `http://h/a/x`; wasm answers the same (Node-exact, S089); the native lanes throw `Uncaught Error: resolving a URL against a base is not supported on this lane yet`, then exit 1. On `URL.canParse("http://h/")` (and every `URL.parse` / `URL.canParse` call, with or without a base): Node answers `true`; wasm answers the same; the native lanes throw `Error: URL.parse and URL.canParse are not supported on this lane yet`. Both Errors are catchable. The entry exists although the wasm tier conforms because the lanes cannot be silently aligned — S066's reason.

The native base is parsed first, as Node parses it, with the native lanes' own subset parser (`packages/runtime/src/scr_url.c`), which rejects IDNA, percent-escaped and IPv6 hosts and differs from Node on some other inputs. So:

- **(a)** A base it rejects throws `TypeError: Invalid URL`, Node's answer, unless the base holds a byte outside its subset (non-ASCII, `%`, `[` or `]`). For those bases the rejection says nothing about Node's answer, so the gap Error is thrown instead, even where Node too would throw Invalid URL (`http://%zz/`).
- **(b)** A base it accepts but Node rejects (`"http://h /"`, a NUL in the host) throws the gap Error where Node throws `TypeError: Invalid URL`.
- **(c)** `URL.parse` and `URL.canParse` never answer from this parser: its `null` / `false` / URL would be silently wrong for exactly those inputs (an IPv6 or IDNA host it rejects, a host with a space it accepts), so they throw.

A base that is omitted or `undefined` is no base on every lane; `new URL(input)` keeps its existing native behavior.

**Rationale:** porting ada's relative resolution and its host parsing into the native subset parser is native work about the size of the wasm transcription, for lanes that are transitional. A named Error is the honest refusal the wasm-first plan allows (S066's precedent: the more capable side conforms, the less capable side refuses rather than approximating), and no native answer here is a silently wrong value.

**Scope:** the llvm and c lanes. On wasm there is no divergence.

**Tested by:** `packages/compiler/test/url-base-native.test.ts` (URL-BASE-NATIVE, one row per native lane, plain and sanitized: an in-subset bad base, an IDNA and an IPv6 base, parseable bases, the statics with and without a base). No corpus program uses a base or the statics, so the corpus cannot pin either side; the wasm side is pinned by S089's URL-BASE rows. Measured against Node v24.18.1.

## S097 — process.stdin on the wasm lane: a host read error on fd 0 is a named trap, leaving a for-await over stdin early does not destroy it, and a for-await reads one chunk per step *(wasm lane only)*

- **(a) A host read error.** A READ_ERROR record (abi.ts `stdinCall`) ends the program with the named trap "process.stdin: a read error from the host is not supported yet", and a READ_START the host refuses with "process.stdin: the host could not start reading fd 0", where Node emits 'error' on process.stdin (to the program's listener, or as the uncaught death). A `process.stdin.on('error', …)` listener is accepted and never called. The harness host's emulated pipe never fails.
- **(b) Leaving a for-await early.** Node destroys process.stdin when a `for await` over it exits early (break, return or a throw out of the body): later listeners never receive anything. Here the stream stays as it was: a 'data' listener added afterwards receives the following chunks and an 'end' listener the end.
- **(c) One chunk per step.** A for-await consumer reads one host read per step and stops reading while the body runs; Node's Readable reads ahead into its buffer up to the high-water mark and hands the next step everything buffered, concatenated. Where a pipe's writer produces data faster than the body consumes it, the chunk boundaries a body sees differ (they are the OS's timing in both cases); the bytes and their order do not.

**Scope:** the wasm lane.

**Tested by:** the stdin and readline surface itself (flowing, 'end', for-await, the readline splitter with its crlfDelay window, question / close, prompts only with an output stream) against Node with piped input: G2-IN-01..05 and G2-RL-01..11 in the "unit G2 stdin and readline rows" block of `tests/harness/wasm-differential.test.ts` (generated from the oracle); 1447, 1475 and 1751 on the wasm census. (a), (b) and (c) are measured, not pinned. Measured against Node v24.18.1.

## S098 — fetch() on the wasm lane: the network half is the host's own fetch (its request checks, redirects, decoding and errors; a browser host answers with CORS, its forbidden headers and "Failed to fetch"), events follow the host, errors carry name, message and code only, Headers.forEach calls its callback with `this` undefined, and the unmodelled surface is fenced by name *(wasm lane only)*

On the wasm lane the global `fetch(input, init?)`, `AbortSignal.timeout(delay)` and the argument-less `AbortSignal.abort()` compile without `--dynamic` (the front end's `hostFetch` mode, set for the wasm backend only) and are built in the module (`packages/compiler/src/backend/wasm/fetch.ts`) over ONE host import, `tsinter.fetch` (abi.ts), and `tsinter.evPoll` source 3. Only plain data crosses: the request goes out as its method, URL (a URL object as its href), redirect mode, header pairs and body bytes (a string body marked as one); the answer comes back as the status, status text, final URL, response type, the redirected and null-body flags, the header list and the body's bytes, or as an error's name, message and cause (name, message, code). Everything a program sees is the module's: the promise, the Response (`status`, `ok`, `statusText`, `url`, `redirected`, `type`, `headers`, `bodyUsed`, `text()`, `json()`, `arrayBuffer()` with its `byteLength`, `bytes()`), the Headers (`get`, `has`, `getSetCookie`, `forEach`; `set` / `append` / `delete` with webidl's argument-count, ByteString, name and value checks before the immutable guard, Node's texts), "Body is unusable: Body has already been read", a null body that reads as empty and never becomes used, `json()`'s SyntaxError, AbortSignal.timeout's `validateUint32` ladder and its unref'd timer, `aborted` / `reason`, and the TimeoutError / AbortError DOMExceptions a signal rejects with. The differential harness's host implements the import with Node's own fetch, so there these are Node's. These differ:

- **(a) The network half is the host's answer.** Request construction (an invalid or relative URL, a bad method, a body on GET or HEAD, credentials in the URL, an invalid header — refused synchronously, so fetch() returns an already-rejected promise, as Node's does), proxying, redirect following, content decoding (gzip, deflate, brotli), the header list's names, order and combining, and the failures ("fetch failed" with its cause, "unexpected redirect") are whatever the host's fetch does. Under the harness that is Node's. A browser host answers with the browser's fetch: CORS (an opaque or `cors` response type, headers it hides), the request headers a browser forbids dropped, a network failure as "Failed to fetch" with no cause, and a relative URL resolved against the page.
- **(b) Event order follows the host.** fetch() fulfils when the module polls the host's head, and the body readers settle when it polls the body — the host reads every body to its end, even one the program never reads, and delivers it whole — not on Node's ReadableStream microtask schedule; a reader called after the body arrived settles at once (one microtask turn to observe it). Within one request the order is Node's (the head before the body); against other requests, timers and promise chains it is the host's. A signal that fires while the head or the body is outstanding rejects at the timer, as Node's does, and the host drops whatever it still had for that request.
- **(c) Errors carry name, message and code only.** The host's error is rebuilt from its name and message as a TypeError, RangeError or SyntaxError (any other name: an Error carrying that name), and its cause from the cause's name, message and code, reachable as `cause` through a dynamic or checked read; the cause's other members (`errno`, `syscall`, `address`, `port`) and every stack are absent, and `util.inspect` does not print a `[cause]` (S027's bracket form). An unhandled rejection is reported as S007 says.
- **(d) The unmodelled surface throws a named Error at run time** (S087 (f)'s stance): `Response.body` (a ReadableStream — streaming, `getReader`, SSE and TextDecoderStream are not modelled), `blob()` (Blob), `formData()` (FormData), `clone()`, any other member of a Response, Headers, AbortSignal or ArrayBuffer value, and `util.inspect`, `JSON.stringify`, `structuredClone`, `Object.assign` or `in` over one. So do a fetch input that is not a string or URL, an init that is not a plain object, an init member the module does not model (`cache`, `credentials`, `integrity`, `keepalive`, `mode`, `referrer`, `referrerPolicy`, `window`, `duplex`, `priority`, `dispatcher`), headers that are not a plain object or a Headers value, a body that is not a string, bytes, null or undefined, and a signal that is not an AbortSignal. At compile time `AbortSignal.any` (`fetch:AbortSignal.any`), `AbortSignal.abort(reason)` (`fetch:AbortSignal.abort:reason`) and fetch in a module that also reaches node:net or child_process's asynchronous spawn (`fetch:with-net-or-child`) refuse by name; `new Headers`, `new Response` and `new Request` keep the front end's fences.
- **(e) Headers.forEach calls its callback with `this` undefined** and ignores a `thisArg`, over the header list as it stood when the call began; Node's undici passes `thisArg`, defaulting to `globalThis`. An arrow callback cannot tell.

**Scope:** the wasm lane. The llvm and c lanes keep refusing a static fetch (SC2012, requires `--dynamic`); under `--dynamic` the c lane's embedded engine runs its own fetch (scr_fetch.c) and is not changed by this entry.

**Tested by:** the "#227 fetch rows" block of `tests/harness/wasm-differential.test.ts`, against the fetch fixtures' local servers: F-FX-01 / F-FX-01d, F-FX-02 / F-FX-02d and F-FX-03 (fetch.test.ts's user-fetch, response-surface and proxy-optin fixtures as static and `@dynamic` builds, full output against Node), F-BODY-01, F-HDR-01, F-SIG-01, F-REQ-01 (a), F-CAUSE-01 (c), F-URL-01 (each against Node), F-FENCE-01 (d at run time), F-UNH-01 (c's report), F-REF-01 (d at compile time), F-HOST-01 (the import, and the native lanes' SC2012); `packages/compiler/test/wasm-fetch.test.ts` (a body past the first poll buffer, a failure after the head, a malformed host record). (b) and (e) are measured, not pinned. Measured against Node v24.18.1.

## S099 — a format specifier meeting an argument this tier cannot convert under it throws a named error from the call, where Node prints *(llvm, c and wasm)*

`console.log` / `info` / `debug` / `error` / `warn`, `util.format` and `util.formatWithOptions({}, ...)` with a first argument that is not a string literal and further arguments run Node's `formatWithOptions` scan at run time (board #237): which argument each `%s %d %i %f %j %o %O %c` consumes is decided by the string the program holds. Each argument converts under its specifier exactly as it would under a literal format string.

- **(a) Statically typed arguments.** Any argument conversion a literal format string refuses at compile time — for example a union such as `string | number` under `%d`, an object or array under `%d` / `%i` / `%f`, `%o` over a type that holds arrays, `%s` of a class with its own `toString`, a typed array under `%s` / `%o` / `%O`, `%j` of a type that is not JSON-safe — and a function value under any specifier but `%c` (Node's `%s` prints the function's source text, which a binary does not carry) do not stop the build. The call throws a catchable `Error` whose message is that compile-time diagnostic's, e.g. `'util.format %o over arrays' is part of the standard library types but has no scriptc lowering yet [SC2020]`, and whose `code` is the diagnostic's code. It throws only when that specifier consumes that argument at run time, and before anything of the call is printed. The same argument as a rest argument, or under a specifier it converts under, prints Node's text.
- **(b) Checked-dynamic arguments** (an `any` binding, a JSON.parse result), under a runtime or a literal format string alike: `%d` takes Number(arg) and `%i` / `%f` ToString(arg) per the value's runtime kind, as Node does — numbers, strings, booleans, null, undefined, arrays through their join, and plain objects through their own `toString` or `[object Object]`. Three kinds refuse by name at run time the same way: an object with its own `valueOf` under `%d` (ToPrimitive would call it first), a Buffer, and, under `%i` / `%f`, a function or an Error value. A value whose ToString throws in the runtime (a symbol) throws a TypeError where Node prints `NaN`.

**Scope:** every lane. Literal format strings keep their compile-time fences for statically typed arguments.

**Tested by:** FMT-FENCE-01 / FMT-FENCE-02 / FMT-DYN-01 in `packages/compiler/test/wasm-fmt-b237.test.ts`; corpus 2746 pins the convertible forms on every lane. Measured against Node v24.18.1.

## S100 — Math answers the bits of V8 13.6's own code on every lane — `base::ieee754` (one vendored copy, compiled for every lane) in binary64 without fused multiply-add, and V8's builtins for the rest: Node's bits where Node's V8 is built that way (x86-64, measured), not claimed elsewhere; a signaling NaN a Math member returns keeps its bits when stored into a `number[]`, where V8 quiets it *(llvm, c and wasm)*

Node v24.18.1 (V8 13.6.233.17-node.50) computes `Math.sin cos tan asin acos atan atan2 exp expm1 log log1p log2 log10 cbrt sinh cosh tanh asinh acosh atanh` with V8's own `src/base/ieee754.cc`: fdlibm 5.3 with V8's changes (`exp(1)` answers `Math.E`; `atan2` with `x == 1` answers `atan(y)`) and FreeBSD msun's `cosh`, `tanh`, `cbrt` and `log2`. Its `sin` and `cos` would be glibc-derived only under `V8_USE_LIBM_TRIG_FUNCTIONS`, which Node's build does not set (as Chrome's does). Measured on 101,024 inputs per function: Node equals that file compiled natively, and differs from glibc 2.43 (e.g. `Math.log(3)`, `Math.cbrt(2)`), from musl, and from the original fdlibm (Java's StrictMath: e.g. `Math.exp(1)`, `Math.cosh(1)`, `Math.cbrt(0.9991103149666114)`).

**What every lane does.** Every member of Node 24's Math object is STATIC on every lane: one libCall per call (`surfaces.ts` STATIC_MATH_FNS; `hypot`, `min` and `max` at any plain arity), no engine and no `--dynamic`, and the eight constants fold to their numbers. The twenty functions above are ieee754.cc ITSELF, kept ONCE: `packages/runtime/vendor/v8-ieee754/src/base/ieee754.cc`, upstream sha256 `1bf99980…a0c2`, unmodified. The native lanes compile it as C++ (`packages/runtime/src/scr_ieee754.cc`, which `#include`s it and exports `scr_ieee754_<fn>`; `cc.ts` ensureIeee754Object: C++17, `-ffp-contract=off`, no exceptions/RTTI, `-nostdinc++` against small header shims, so no C++ library is needed or linked; linked when the IR calls one of them, and in every `--dynamic` build). The WasmGC tier compiles the text `scripts/gen-wasm-ieee754-src.mjs` renders from that file (`backend/wasm/ieee754-src.ts`: the file minus its unused legacy `pow`; a drift test holds the two byte for byte) with a compiler for the C subset it is written in (`csubset.ts`: C's integer types, conversions and signedness exactly; IEEE-754 binary64, round to nearest, no contraction), a function per module on first use, with what it calls (`scalbn` is musl's, exact). One native wrapper detail: `atan2` with BOTH arguments NaN answers the first NaN operand of ieee754.cc's `x + y` in Node's operand order (the C++ compiler is free to swap a commutative addition; Node's build does not). The members V8 computes in its builtins are ported from V8's source per runtime and held to the same rows: `hypot` is `math.tq` MathHypot (an infinite argument answers Infinity before a NaN one; the 3-argument compensation term; the Kahan-summed path past three arguments); `pow` is `**` (S079, V8's `math::pow`); `sqrt`, `fround`, `clz32` and `imul` are the instructions (over ToUint32/ToInt32); `sign` is V8's (±0 and NaN answer themselves); `f16round` rounds the double once, ties to even, to binary16 and back, and answers a NaN as the quiet NaN with the argument's sign; `min`/`max` answer the machine's invalid-operation NaN for any NaN operand (`fff8000000000000` on x86-64, whatever the operands' payloads, measured; one argument is compared with the fold's seed, as V8 does); `round` answers a NaN quieted. The runtime's C and the emitted C program are compiled with `-ffp-contract=off` too, so no helper's arithmetic (hypot's Kahan step, say) is contracted into a fused multiply-add on a target whose compiler would. An `any` argument is converted with ECMA-262 ToNumber (S104). Under `--dynamic` on the native lanes, the embedded engine's own Math members — what the engine itself evaluates: packages, a Math object reached as a value, `__island_eval` — are replaced at context creation (isl_install_math in `scr_island_math.h`, the vendored engine unmodified; the wasm lane's engine runs the same file, S103 (f)) by functions over the same code — the twenty transcendentals, `pow`, `hypot`, `sign`, `f16round`, `round`, `min` and `max` — so they answer the same bits (S104 (c) is what this cannot reach).

NaNs: each function returns the bits Node returns, payload and sign included — ieee754.cc's `signaling_NaN()` is `7ff4000000000000` (`Math.log(-1)`, `log2`, `log1p`, `acos`, `asin`, `acosh`, `atanh` outside their domain), its `quiet_NaN()` `7ff8000000000000` (`log10`), and an arithmetic NaN is the hardware's (`Math.sin(Infinity)`, `Math.sqrt(-1)`: `fff8000000000000` on x86-64; S036's "does not fold" row).

**The divergences registered.**
- **(a) Other builds of Node.** The bits are those of ieee754.cc compiled without contraction, and of V8's builtins on x86-64. A Node whose V8 compiles that file with fused multiply-add (for example clang's default `-ffp-contract=on` on arm64), or with `V8_USE_LIBM_TRIG_FUNCTIONS`, can differ in the last bit; a non-x86 machine's invalid-operation NaN (the min/max and negative-base `**` NaNs) differs in sign. None of these was measured, and none is claimed. The test rows take their expectations from the Node that runs them, so such a Node reddens them rather than passing them stale.
- **(b) A signaling NaN stored into a `number[]`.** V8 quiets a signaling NaN on its way into a double-elements array (`[Math.log(-1)][0]` reads back `7ffc000000000000`; a record field, a Map value or a tuple slot keeps `7ff4…`). Every lane stores the bits, so the array element reads back `7ff4000000000000`. The same already held for a signaling NaN read from bytes (`buf.readDoubleBE`), the only other in-tier source of one; Math is a new source. Board #261 measured V8's own answer per operation (Node v24.18.1, `7ff4000000000000` from bytes): an array literal, `push` (onto an empty, small-integer or double array), an index write, `map`, `concat`, spread, `slice` of a quieted array and `new Float64Array([x])` set the quiet bit (`7ffc…`; `fff4…0001` gives `fffc…0001`), while `fill` and `unshift` store the canonical `7ff8000000000000`, and an array holding a string keeps `7ff4…`. That is two rules depending on which V8 path stores the element, not one conversion, so this tier keeps the bits on every lane (c, llvm and wasm agree, measured) rather than imitating a per-method answer.
- **(c)** (retired) `Math.pow`'s own NaN: now Node's (S036's `**` row, board #158 fixed).
- **(e) `Math.max` / `Math.min` with a NaN argument depend on Node's JIT tier.** The builtin answers the machine's invalid-operation NaN (`fff8000000000000`) whatever the argument's payload; optimized code can answer otherwise: `Math.max(x)` returns x's own payload once hot (measured: `7ff8dead0000beef` after ~15,000 calls), and the unit's review observed `7ff8000000000000` from optimized two-argument forms (a hot two-argument loop here stayed `fff8…`). Every lane, and the native engine's own members, answer the builtin's `fff8000000000000` (S104 (b) is the same kind of row for floor/ceil/trunc).
- **(d)** (retired) The native lanes computed these members in their embedded engine over the system libm (board #262): they compute ieee754.cc now, as above.

**Scope:** every lane, every build (plain and `--dynamic`); (b) and (e) every lane.

**Tested by:** `packages/compiler/test/math-ieee754.test.ts`, on the wasm, c AND llvm lanes — per function about 4,000 seeded inputs plus the edges, both sides of every high-word threshold in that function's C text, and k·π/2 near and far (IEEE, ATAN2 with every NaN-payload pair, HYPOT arities 0–6, EXACT incl. `pow` and `**`), compared bit for bit with the live Node; DYN (ToNumber, plain and `--dynamic`, an island object's valueOf/toString and their throws), NAN (the bits above, signaling NaNs through every member, min/max, literal `**`, and (b) pinned both ways), DISC (seven inputs on which glibc or the original fdlibm answers otherwise), DYNAMIC (every member in a `--dynamic` build), ENGINE (c, llvm: the embedded engine's own Math over 600+ inputs per member, min/max/round included), LINK (the ieee754 object is linked exactly when used), LAZY (a wasm module carries only what its members reach). `packages/compiler/test/wasm-ieee754-src-drift.test.ts` pins the vendored file's sha256 and the generated wasm text to it. Offline: the nineteen one-argument functions and `atan2` over 2,000,000 inputs each, natively compiled vs Node, every bit equal; the wasm text over 10,001,369 inputs each. Corpus 1110, 2755 and 2757 print raw transcendentals on every lane. Measured against Node v24.18.1 on x86-64.

## S101 — zlib.deflateSync / zlib.inflateSync: errors carry name, message and code only (no `errno`), a result's `byteOffset` is 0, and sizes past the engine trap; the island's node:zlib shim carries only `level` and buffers its streams *(every lane; (e) the llvm and c lanes' island)*

Every lane computes zlib with the zlib Node v24.18.1 bundles (`process.versions.zlib` "1.3.1-e00f703", Chromium's fork): deflate.c with Chromium's multiplicative `insert_string` hash, its four-byte `fill_window` insert and LIT_MEM symbol buffers, all of trees.c, and inflate.c's state machine with inftrees.c's table builder. The wasm lane computes it in the module (`packages/compiler/src/backend/wasm/zlib.ts`, a port of that source); the llvm and c lanes link that source itself (`packages/runtime/vendor/zlib-chromium`, built scalar as Node builds it on targets without SIMD, on host and cross builds alike — no system libz; `packages/runtime/src/scr_zlib.c`). Every lane drives it as Node's `processChunkSync` does (Z_FINISH with a fresh 16 KiB of output for as long as a call fills it), so deflateSync's bytes are Node's at every input, on every lane; inflateSync fails where Node's fails, with zlib's message (or Node's "Missing dictionary" and "unexpected end of file") and Node's `code` (`Z_DATA_ERROR`, `Z_NEED_DICT`, `Z_BUF_ERROR`), ignores bytes after the stream's end as Node does, and throws a plain `Error`. These differ:

- **(a) An error carries name, message and code only.** Node's also has an own `errno` (-3, 2 or -5 for those codes); no lane's error model has a slot for it. `e.errno` has no lowering on any lane (a compile-time refusal), so the difference shows only where an error is inspected (S021, S027), serialized or reported uncaught (S007). `JSON.stringify(e)`: Node `{"errno":-3,"code":"Z_DATA_ERROR"}`, the wasm lane `{"code":"Z_DATA_ERROR"}`, the llvm and c lanes S021's encoding `{"%error":true,"name":"Error","message":"incorrect header check","code":"Z_DATA_ERROR"}` (measured 2026-10-26). The same shape as S073 and S093 (a).
- **(b) A result's `byteOffset` is 0.** The result is a Buffer over its own bytes. Node's is a slice of a larger allocation its output chunks came from, at an offset that depends on earlier allocations (`deflateSync(Buffer.from("hi")).byteOffset` measured 2272 in one Node run and 1832 in another; 0 on the wasm, llvm and c lanes).
- **(c) Sizes past the engine trap.** An input or output the lane cannot allocate as one array, on the wasm lane a work area (about 290 KB of linear memory) the module cannot grow, and on the llvm and c lanes an input over 4 GiB (one codec call's `avail_in`; the trap names it), is an uncatchable trap; Node allocates it or throws its own RangeError. Not measured at the limit.
- **(e) The island's node:zlib shim (`--dynamic`, embedded npm code; llvm and c lanes) carries only `options.level`.** Its sync and callback codecs (`deflateSync`, `deflateRawSync`, `gzipSync`, their inverses, `unzipSync` and the callback spellings) validate `level` as Node does — undefined or NaN take the default, a non-number throws Node's `ERR_INVALID_ARG_TYPE` TypeError, ±Infinity and values outside -1..9 throw Node's `ERR_OUT_OF_RANGE` RangeError, with Node's texts — and then compute Node's bytes and errors as above. Every other option is silently ignored: `strategy` (changes the bytes at any level), `windowBits`, `memLevel`, `chunkSize` (Node's output chunk; changes level-0 bytes, where stored blocks are sized from it), `dictionary`, `finishFlush`, `maxOutputLength` and `info`; a program passing them gets the default-option result where Node's differs. The stream classes (`createDeflate`, `createGzip`, ..., and the class constructors) are BUFFERING transforms: they collect every write and compress once at flush, so their output arrives in one chunk at the end and is the one-shot result over the concatenated input, where Node compresses each write as it arrives (Z_NO_FLUSH) — Node's own multi-write output differs from its one-shot bytes (measured 34 of 120 seeded multi-write cases, levels default and 0; the unit review measured 47 of 120), and `flush()`, `params()` and `bytesWritten` timing follow from the buffering. Fixed by carrying the options and a streaming bridge; neither exists yet.

How deflate is driven and which inflate decoder runs are not observable: the wasm port does not port `inflate_fast`, because it decodes the same codes with the same checks and the slow path reaches the same output and the same error at the same input byte (Z-ERR-02 and Z-ERR-03 below sweep this); the llvm and c lanes run zlib's own inflate, `inflate_fast` included.

Until 2026-10-26 a clause (d) registered that the llvm and c lanes' deflate bytes were not Node's: they called the system zlib through `compress2`, whose canonical hash gave other bytes for about half of all inputs (board #257). Board #257 retired it: those lanes now link Node's zlib and drive it as Node does, and no lane's bytes differ.

**Scope:** every lane ((c)'s 4 GiB clause the llvm and c lanes, its work-area clause the wasm lane; (e) the llvm and c lanes' island shim — the wasm lane does not embed npm code).

**Tested by:** `packages/compiler/test/zlib-lanes.test.ts`, the one shared table: corpus 1404 and 2756 and the fixtures `fixtures/zlib/deflate-bytes.ts` (deflate bytes over every kind of input at every boundary size) and `fixtures/zlib/inflate-errors.ts` (every error input, every truncation of several streams, a byte flip at every offset of one, seeded mutation fuzz) compiled for the wasm, c and llvm lanes, each lane's stdout equal to Node's run of the same program (Z-LANES-01..04; replacing a system libz on the native lanes turns Z-LANES-02..04 red); 1404 and 2756 on the c, llvm and wasm differential lanes; the "zlib unit rows" block of `tests/harness/wasm-differential.test.ts` (ZL-RT-01 round trips, ZL-HEX-01 deflate bytes, ZL-ERR-01 every error kind's name, message and code, ZL-HOST-01 no import); `packages/compiler/test/wasm-zlib.test.ts` (the wasm port in-process: Z-DEF-01..03 deflate bytes at every boundary size, 300 fuzzed lengths and every level 0-9 against live Node; Z-RT-01; Z-INF-01 Node-produced streams across levels, strategies, memLevels and windowBits; Z-ERR-01 one input per error with Node's errno pinned per (a); Z-ERR-02 every truncation of seven streams; Z-ERR-03 seeded mutation fuzz); the npm case `zlib-shims` (the island's node:zlib shim on the c lane: zlib, raw and gzip bytes at levels 0, 1, default and 9, "Missing dictionary", and (e)'s level validation: NaN, 3.7, 10, -Infinity and a string). (b) is measured, not pinned; (c) is not measured. Measured against Node v24.18.1.

## S102 — a run-time `new RegExp` pattern or flags string outside this tier, or a syntax error whose V8 wording or precedence is unmeasured, throws a catchable named Error where Node builds the regex or throws a SyntaxError *(every lane since follow-up unit D — see its amendment below; wasm lane only before it)*

`new RegExp(pattern, flags)` over strings known only at run time compiles
in the module (S065's run-time arm). For a pattern outside the tier it
throws an `Error` (name `Error`) whose message is `new RegExp(): '<key>'
is not supported yet` and whose `code` is `libCall:regex.new:<key>`, the
census key word for word, thrown at the construction point and
catchable — and since unit E (review M2) a CONSTANT `new RegExp` with the
same texts throws the same Error at the call rather than refusing the
build (a regex literal outside the tier still refuses at build time by
`expr:regexLit:<key>`). Keys: `unicode-sets-flag` (/v), `unicode-casefold` (/i with
/u), `modifiers` (a `(?ims-ims:…)` group that changes how an atom
compiles), `unported-unicode-property` (a `\p{…}` name outside
General_Category, including Script and binary properties Node knows),
the eight `annexb-*` families of legacy syntax (S065's literal arm
refuses the same ones), `too-many-captures` (255; V8 allows more),
`too-many-registers`, `too-many-ranges`, `nesting-depth` (256 nested
groups), `pattern-too-large` (below). Node builds every one of these that
is valid, or throws its SyntaxError for one that is not.
`unported-unicode-property` covers every `\p{…}` name only Node's
property tables can judge — a Script value (`\p{sc=Greek}`), a lone
non-General_Category name (`\p{Alphabetic}`) — INCLUDING the ones Node
rejects (`\p{Foo}`, `\p{sc=Foo}` are its "Invalid property name"
SyntaxError here, the fence on this tier); names malformed in a way V8
decides without the tables throw V8's SyntaxError (S065's unit E
amendment). Precedence: the fences `modifiers` and
`annexb-class-range-escape` (since unit E) and the Annex-B families wait
for the whole pattern to parse, so any syntax error in it is V8's
(`[\w-a][a` is "Unterminated character class", `(?i:a)(` "Unterminated
group"); the other fences are reported where met, ahead of a later syntax
error Node would report (`\p{Alphabetic}(` under /u fences where Node
says "Unterminated group" — the name might have been invalid, and then
Node's error would be that one). Under /iu the /u grammar runs first, so a syntax error wins over
`unicode-casefold` (`(?i:a){2,1}`, `\p{L=}`) except behind a where-met
fence (`\p{Alphabetic}(` /iu is `unicode-casefold`). A flags string with
both `u` and `v` is Node's "Invalid flags" SyntaxError, before the /v
fence.

**`pattern-too-large`.** V8 compiles a regex lazily, at its first
match, and there throws "Regular expression too large" or "Stack
overflow" for a large pattern (a valid one it constructed without
complaint) — at a size that depends on the construct mix and the native
stack: measured with Node v24.18.1, 32,768 plain characters fail, 32,767
pass; the smallest failing pattern found was 14,008 code units of `a+`
under /u (`a?` 17,832, `(?<=a)` 34,056 — sweeps over 28 one- to
three-character units and five nestings). No crisp limit exists to
mirror, so a valid pattern longer than 8,192 UTF-16 code units is fenced
at construction (every unit swept at 8,192 compiled and ran in Node), and
a regex literal or folded constant that long refuses at build time
(`expr:regexLit:pattern-too-large` / `libCall:regex.new:pattern-too-
large`). Node builds and matches patterns between 8,193 code units and
its own limit; this tier refuses them by name.

**Build time runs the same compiler (unit E).** There is one regex
compiler: a regex literal, a literal `.split()` receiver's sticky clone
and a `new RegExp` whose texts fold are compiled by running this
compiler at build time (S065's unit E amendment), so a constant pattern
gets exactly the run-time verdict — the value (source, canonical flags,
bytecode), V8's SyntaxError text (a constant throw), or the fence (for a
`new RegExp` the named Error thrown at the call; for a literal a
build-time refusal `expr:regexLit:<key>`, and a literal's own
SyntaxError refuses as `expr:regexLit:invalid-pattern` since Node
rejects the whole script).
Where
V8's checks differ from libregexp's the run-time compiler follows V8: a
duplicate group name is checked as the group closes with V8's own
"non-participating interval" rule (which accepts some duplicates the
ES2025 rule rejects, e.g. `(?<a>y)(?:z|(?<a>w))`); an undefined
`\k<name>` is reported after the whole pattern parsed; `a{2,1` without
/u is a literal.

**Measured, not assumed.** The gate of record compares the compiler
with libregexp's `lre_compile` (bytes) and with Node (verdict, source,
flags, message) over 31,114 (pattern, flags) pairs: the 140 claim
patterns, the generated grammar corpus, every regex literal and
`new RegExp(<literal>)` in tests/corpus, the regex unit tests' fixtures
(frozen since unit E retired the TypeScript pipeline's own tests),
hand-picked precedence rows and 30,000 seeded mutations — 10,697 built,
15,885 SyntaxErrors, 4,532 fenced; zero accepted where Node throws, zero
wrong messages, and no literal built where Node rejects. Until unit E it
also held the compiler byte-identical to the build-time TypeScript
pipeline (zero differences wherever both built); that pipeline is gone.
Four further 300,000-mutation sweeps (seeds 7, 11, 12, 21) were run by
hand at unit P1, clean.

**Cost.** A module that needs the run-time compiler carries it: about
58 KB of code and tables (the review's measure, 84,886 against 26,898
bytes for the same small program with a constant pattern). Since unit E
the compiler PROCESS pays once for its first constant pattern: it emits
and instantiates the standalone compiler module (62,249 bytes; 72,029
since unit D, which put the matcher in the same module for the native
lanes' translation) and
derives its tables (Canonicalize pairs and the identifier ranges, one
pass over every code point) — measured about 0.2–0.3 s, once per
process; each pattern after that costs microseconds.

**Scope:** every lane since follow-up unit D (below); before it, the wasm
lane only, the native lanes compiling with libregexp under S065's native
arm.

**Amendment (follow-up unit D): every lane.** The native lanes run this
compiler and the wasm tier's matcher, translated to C
(`packages/runtime/src/scr_regex_engine.h`, generated from the module
`regex-engine-module.ts` builds by `backend/wasm2c.ts`; S065's unit D
amendment), so everything above holds on c and llvm word for word: the
same fences by the same keys, messages and `code`s, the same V8
SyntaxError texts and precedence, the same canonical `.flags` and
escaped `.source` (`new RegExp("a/b").source` is `a\/b`, a line
terminator `\n`), the same `d` handling (`"dg"` builds, `"gg"` is
"Invalid flags"), the same duplicate-group-name and `\k`-in-a-class
verdicts (`((?<a>x)|y)(?<a>z)` and `(?<a>x)[\k]` are V8's SyntaxError,
where libregexp built them), and the same matcher — V8's rules between
the halves of a surrogate pair under /u included (#269: `"a😀b".search(/\B/u)`
is 2 on every lane). A regex LITERAL outside the tier refuses the native
build by `expr:regexLit:<key>` as it refuses the wasm one (a pattern Node
itself rejects says so: `expr:regexLit:invalid-pattern`, worded as an
invalid regular expression, not a coverage gap). A native build with a
regex literal therefore needs a compiler HOST that runs WasmGC — Node 22
or later, as the wasm lane already did; elsewhere the literal refuses by
`expr:regexLit:build-time-compiler-unavailable`, as on wasm. Consequence,
by Joe's ruling D4 (one outcome on every lane until both lanes support a
feature): a native program that used one of these features now refuses
or throws the named Error where it used to run — /i with /u, /v, modifier
groups, `\p{Script=…}` and the other table-only property names, the
Annex-B legacy forms, more than 255 captures, patterns past 8,192 code
units. No corpus or fixture program is affected (every regex literal
and constant `new RegExp` under tests/ was swept: none is fenced; the 44
regex corpus programs pass on c and llvm, plain and sanitized). Measured
by `packages/compiler/test/native-regex-lanes.test.ts`: the pool above
through one program on wasm, c and llvm — the three outputs identical
byte for byte, and equal to Node's on every row but the fenced ones
(4,481 fenced, by key) — with the exec sweep's search / test / match /
replace / replaceAll / matchAll over 12 subjects for 3,671 of the
accepted rows.

**Tested by:** `packages/compiler/test/wasm-regex-runtime-compiler.test.ts`
(the gate), `packages/compiler/test/wasm-regex-runtime-new.test.ts`
(RTN-01..07, end to end against Node; RTN-03 pins the fence's message and
code), `packages/compiler/test/wasm-regex-disposition.test.ts` (one
witness per fence key, and the syntax errors a fence must not hide),
corpus 2448 and 2748 on the wasm census. Measured against Node
v24.18.1.

## S103 — `__island_eval` on the wasm lane runs in the embedded engine: its recursion depth is about a tenth of Node's and some deep engine recursion overflows the host stack uncatchably, Node globals and locale methods it lacks are fenced by name, its jobs run at the checkpoint instead of in Node's microtask queue, its error messages and some limits are QuickJS's, its local time is the host's (S113; once UTC), its NaNs are canonical and its `**` operator is musl's pow, an error crossing out keeps name, message and a string code only, a rejection with an 'unhandledRejection' listener is fenced, and replacing `globalThis.eval` does not change what `__island_eval` runs *(wasm lane; (b), (c), (d) and (i) are shared with the native lanes)*

A module that reaches `__island_eval` carries the quickjs-ng engine the native
lanes embed, at the same pin, compiled to wasm32 with wasi-libc
(`scripts/build-engine-wasm.mjs`; the artifact is
`packages/runtime/vendor/quickjs-ng-wasm/engine.wasm`, spliced into the module
by `packages/compiler/src/backend/wasm/engine.ts`). Such a module has TWO
linear memories (the engine's heap is memory 0 and is not exported; the
module's own, exported as `memory`, is memory 1), so its host must support
multi-memory (Node 24 and wasmtime do; Safari is unverified); every other
module keeps one memory and is byte-identical to a build without engine
support. The engine evaluates the source as an indirect eval — `(0,
eval)(code)`, the corpus oracle's own shim (`tests/harness/island-shim.mjs`):
`let`/`const` stay local to one eval, `var` and functions land on the global
object, and globals persist for the whole run. It is the engine's own
indirect eval entered directly ((i)), under the native lanes' file name
`<island>`, so an engine stack reads the same on every lane (S114). The answer is
`String(result)` (a symbol renders `Symbol(desc)`), numbers formatted by the
tier's own formatter. The engine's `Math.random` is the module's own
generator (S068), so static and island draws share one sequence, as in Node.
An engine exception crosses as the native bridge renders it
(`isl_throw_reason`): an Error as a builtin error picked by name (TypeError,
RangeError, SyntaxError; any other name rides an Error-rooted instance), any
other value as `String(value)`, a string payload. Everything else is Node's,
except:

- **(a) Recursion depth, and the host stack.** The engine checks its own C
  stack against a 256 KiB budget (`packages/runtime/src/wasm/isl_core.c`,
  `ISL_STACK_BUDGET`; the vendored engine's "no limit under WASI" was patched
  out — see `packages/runtime/vendor/README.md`). Past it, a catchable
  `RangeError: Maximum call stack size exceeded`, as in Node — but sooner:
  `function d(n) { return n === 0 ? 0 : 1 + d(n - 1); }` reaches 1,020 frames
  in the engine where Node's indirect eval reaches 9,610. The engine's frames
  are also wasm frames on the host's stack, shared with the program's own,
  and the budget measures only the engine's C stack, so what the host has
  left decides the rest. Measured on Node v24.18.1 with the module run by
  the test host: unbounded JS recursion inside the eval stays catchable with
  up to 4,700 static frames below the call site when each of them holds a
  `try`/`catch` (4,800 overflows the host) and with at least 6,000 plain
  static frames; at the top level these overflow the HOST stack first — the
  host's RangeError ends the run, uncatchable, where Node throws a catchable
  RangeError: `JSON.stringify` of a 100,000-deep object, an eval of 100,000
  nested parentheses, `JSON.parse` of 100,000 nested arrays (Node parses
  it), `flat(Infinity)` over 100,000 nested arrays. `String()` of 100,000
  nested arrays and a 100,000-deep Proxy chain are caught. No single budget
  fixes the list: swept at 64, 128 and 256 KiB, each budget catches a
  different subset of these shapes and smaller budgets halve the depth. The
  native lanes budget 128 KiB on a fiber and 4 MiB on the main stack.
- **(b) Node globals and locale methods the engine does not have are
  fenced — on every lane.** Every own property name of Node's global
  object (generated from Node v24.18.1 into
  `packages/runtime/src/wasm/node_globals.h` by the build script) that the
  island still lacks once it has booted is an accessor that throws a
  catchable `Error` whose message is `<name> inside the scriptc island is
  not supported yet (SEMANTICS.md S103)` — `typeof` included — where Node
  answers its object. The fence is ONE piece of the shared web prelude
  (`internals.fenceGlobals` in `scr_web_prelude.js`), which each lane
  calls last at boot with the same generated list: the wasm engine in
  `isl_core.c`, the c and llvm lanes' island in `scr_island.c` after
  every boot script of the build (the npm bootstrap, the fetch glue) has
  defined what it carries. So the fenced set is what that build lacks: on
  the wasm lane 43 names, recorded in
  `vendor/quickjs-ng-wasm/engine-fence.json` (among them `setTimeout`,
  `setInterval`, `clearTimeout`, `clearInterval`, `URL`, `Intl`, `Atomics`,
  `WebSocket`, `WritableStream`, `FormData`, `process`, `Buffer`, `fetch`,
  and the performance classes); in a plain native `__island_eval` program
  the same list less the four timers and `Atomics`, which the native
  engine has (38 names, measured); fewer in a build that carries more
  (`process`, `Buffer`, `global`, `setImmediate` in npm-importing
  programs, `fetch` in fetch-using ones). `URL`, which the native lanes
  install lazily (when an npm package or a URL value first reaches the
  island), replaces its fence when it is installed. The island boots its
  own web-platform globals first (S108: `console`, `TextEncoder`,
  `TextDecoder`, `URLSearchParams`, `btoa`/`atob`, the streams, `crypto`
  `Crypto` and `SubtleCrypto`, `structuredClone`, `performance`, the
  event, abort, fetch-value and message classes; 67 fenced names before
  phase 2 E2), so only what neither has is fenced. On the wasm lane the
  four timer functions are the exception: the shared text defines them,
  but this lane has no bridge from the engine onto the module's timers
  yet, so they are removed again and fenced like the rest, and
  `AbortSignal.timeout` — the other timer user — throws a named error
  (`AbortSignal.timeout inside the scriptc island is not supported yet on
  the wasm lane (SEMANTICS.md S103)`). Its `crypto` draws from the
  module's `random` import (abi.ts), which every engine-carrying module
  now imports. Assigning a fenced global replaces the fence with an
  ordinary global of Node's enumerability for that name (the build script
  records Node's enumerable global names beside the list). Without `Intl` the engine's locale-sensitive methods
  answer differently from Node (`(1234567.891).toLocaleString()` is
  `1234567.891`, Node prints `1,234,567.891`; the native engine's
  `'a'.localeCompare('B')` compares code points where Node's ICU
  collates, and the wasm engine had no `localeCompare` at all, board
  #309), so on every lane `Number`, `BigInt` and `Date`
  `toLocaleString`, `Date` `toLocaleDateString` and
  `toLocaleTimeString`, and `String` `localeCompare`, `toLocaleLowerCase`
  and `toLocaleUpperCase` throw the same named error (message
  `<Class>.prototype.<method> inside the scriptc island ...`, each with
  Node's `length`); array and typed-array
  `toLocaleString` reach them through their elements. Where the compiler can
  see the eval's source — a string literal in the argument that references
  a fenced global in identifier position (not inside a quoted string, a
  comment, or after `.`) — the program refuses at build time instead
  (`libCall:island.eval:engine-global:<name>`; corpus 1120 refuses this
  way).
- **(c) Engine jobs run at the checkpoint.** A promise reaction created inside
  an eval runs after the static checkpoint drains (after every static
  microtask and tick, before the next macrotask), the station the native lanes
  drain the engine at (`scr_island_drain_jobs`, at loop quiescence) — not in
  Node's single microtask queue. Observable through a later eval: after
  `await null`, an eval that queues `globalThis.w = 7` and, after a second
  `await null`, an eval reading `w`, prints `undefined` where Node prints `7`.
  A job the engine cannot complete prints `Uncaught <String(error)>` and exits
  1, as native does. The native lanes run their event loop in every program
  that reaches the engine, so jobs an eval queues — and the engine's
  unhandled rejections — are drained and reported at the exit checkpoint
  even when the static program has no async work of its own (board #272).
- **(d) Engine error messages and limits are QuickJS's.** The name is right;
  the text can differ from V8's: `null.x` is `cannot read property 'x' of
  null` (Node: `Cannot read properties of null (reading 'x')`), `undefined()`
  is `not a function` (Node: `undefined is not a function`). Engine limits
  differ too: a regex with 5,000 nested groups is a SyntaxError (Node
  matches it); a chain of 10,000 `bind`s throws RangeError when called
  (Node answers). The native lanes run the same engine and print the same
  texts.
- **(e) Local time — RESOLVED (the engine follow-up of the local time zone
  unit).** wasi-libc's `localtime_r` has no time zone, so the engine used to
  answer every local-time method and `toString` in UTC. The engine's Date now
  reads the host's zone through `tsinter.tzCall` (S113): quickjs-ng's zone
  hooks are defined in this build too, isl_core.c's `scr_tz_offset_ms` /
  `scr_tz_local_to_utc` ask OFFSET (through the static tier's own checked
  `%w.date.zoneOffset`), and the `Date#toString` / `#toTimeString` suffix asks
  NAME at V8's equivalent instant — the native lanes' rules, over the host.
  What remains is S113's.
  `toString` and `toTimeString` carry the suffix ` (Coordinated Universal Time)`,
  Node's under `TZ=UTC` (S108's Date patch).
- **(f) Math inside the engine is Node's, but a NaN loses its bits and the
  `**` operator is musl's.** The engine's Math members are replaced at
  context creation exactly as on the native lanes — the same code,
  `packages/runtime/src/scr_island_math.h` over `scr_jsmath.h`'s ports and
  the vendored V8 `ieee754.cc` (`scr_ieee754.cc`), all compiled into
  `engine.wasm`; `Math.pow`'s general case is the module's own `**`
  (`%w.jsPow`, S079), since wasi-libc's `pow` is musl's — so every Math
  member answers Node's bits (`math-ieee754.test.ts` ENGINE [wasm]). Two
  things stay apart. The engine is a 32-bit build, so it NaN-boxes its
  values: every NaN a value holds is `7ff8000000000000` — `Math.min(NaN,
  1)` read back through a `Float64Array` is `7ff8000000000000` where Node
  and the native lanes' 64-bit engine answer `fff8000000000000` (measured);
  only a NaN's bits differ, never whether a value is NaN. And the `**` OPERATOR (QuickJS's own,
  which no Math override reaches) is musl's `pow` without V8's `y = 2` /
  `y = 0.5` pre-cases: over 2,000 pseudo-random `a` in [0, 20), the last
  bit differs from Node for `a ** b` (b in [-3, 3)) 2 times, `a ** 2` 19
  and `a ** 0.5` 2 (the native lanes' engine, over glibc: 0, 41 and 1 —
  S104 (c)); `Math.pow` 0 on both. (Before the shared override, measured
  over 2,000 inputs: sin 19, cos 25, exp 206, log 142 and log1p 1 differed.)
- **(g) An unhandled engine rejection** prints the native lanes' line,
  `Unhandled promise rejection: <String(reason)>`, and exits 1 (S010's shape)
  at the checkpoint after the engine's jobs ran (a handler attached by then
  rescinds it). With an `'unhandledRejection'` listener registered, it throws
  a named `Error` (`an island promise rejection with an 'unhandledRejection'
  listener registered is not supported yet (SEMANTICS.md S103)`) uncaught,
  where Node calls the listener.
- **(h) An Error crossing out of an eval keeps its name, message and a
  string `code`.** Its `cause`, `stack`, a non-string `code` and every other
  own property are lost: `throw Object.assign(new Error('m'), { code: 'E1',
  extra: 5 })` caught statically reads `code` `E1`, `extra` undefined and
  `stack` undefined (Node: `5` and a string); `new TypeError('t', { cause:
  'c' })` reads `cause` undefined (Node: `c`). The native lanes also drop
  `code`. Like every non-Error value, a thrown symbol arrives as its
  `String()` — the string `Symbol(desc)` — where Node's catch sees the
  symbol itself (native: the string `Error: unrepresentable island
  exception`).
- **(i) `__island_eval` is not `globalThis.eval`.** The oracle's shim calls
  whatever `globalThis.eval` is at that moment; the island enters its
  engine directly — the wasm lane the engine's own indirect eval, the
  native lanes a global script (`JS_Eval`) — so a program that replaces
  `globalThis.eval` (inside an eval: `globalThis.eval = (s) => 'mine'`)
  changes what later evals run in Node and not on any lane here.

The engine's heap is never torn down; its counting allocator returns to the
same live count after any number of evals, throws and job drains (the unit
test reads it). A module that reaches `__island_eval` is about 842 KB larger
than one that does not (841,906 bytes: a one-eval hello world, 842,783
bytes, against the same program written without the eval, 877; phase 2 E2
added 176,273 of them — S108's shared web globals and (f)'s Math).

**Tested by:** `packages/compiler/test/wasm-island-engine.test.ts` — (a)
the catchable overflow with 2,000 static frames below it and a host
overflow, (b) the global and locale fences, the generated lists' agreement
and the build-time refusal (and `tests/harness/island-inspect.test.ts`'s
fence row: the same messages on the c, llvm and wasm lanes, a replaced
fence; `web-globals.test.ts`'s presence row on both lanes), (c) job timing against timers, (d) and (e) the
texts and the zone, (g) the rejection line and the listener fence, (h) the
carried code and the lost properties, the shared Math.random sequence, plus
the leak oracle, the artifact's format check, its SC3002 diagnostic and the
zero-cost rule, the timer fences and the UTC Date suffix (E2);
`math-ieee754.test.ts` ENGINE [wasm] — (f)'s Math members against Node — and corpus
1100, 1101, 1102, 1120 and 1206 on the wasm census.
(f)'s `**` and NaN figures, the depth figures and the host-stack shapes in
(a), and the limits in (d) were measured by hand, outside the suite. Measured against Node v24.18.1.

## S104 — Math converts its arguments with ToNumber as Node does, after evaluating all of them; floor, ceil and trunc of a signaling NaN answer optimized Node's quieted bits; code the native lanes' embedded engine evaluates keeps QuickJS's `**` operator and its ToNumber error text *(llvm, c and wasm; (c) and (d) the native lanes under `--dynamic`)*

Every Math member is static on every lane (S100). Its arguments go through ECMA-262 ToNumber first, as
Node's Math does (board #263: `Math.abs("-7.5")` on an `any` threw "expected number" on every lane): a
number is itself, a string StringToNumber, a boolean 0/1, an `undefined` / `null` literal NaN / 0 (the
forms a JavaScript file can pass; any other JSON-safe type, a union with unit arms included, crosses into
a dyn value first); a checked-dynamic `any` value goes through
`dyn.toNumber` (`scr_dyn_to_number` on the native lanes, `%w.dyn.toNumber` on the wasm tier) and an
island value through the unary plus — on the native lanes the engine's own conversion, on the wasm tier
`%w.dyn.toNumber`, which `+v` and `-v` on an island value now use too (an own `valueOf` used to be
ignored there: the unary half of board #251). The binary operators on island values (`+ - * / % **`
and `< <= > >=`) now convert each operand the same way first, left operand then right, on the wasm tier
through `%w.dyn.toPrimitive` (board #251's binary half: `o + 1` with an own `valueOf` answering 42 is
43, as on the native lanes' engine; an own `toString` serves `+` when there is no own `valueOf`; a
throw propagates before the right operand converts). An object runs
OrdinaryToPrimitive with the number hint over its `valueOf` / `toString` (a call's throw
propagates; neither giving a primitive is Node's "Cannot convert object to primitive value"). On the
wasm tier both conversions find each member as a read would: an object's own member, else its
prototype chain's (an island object built by `Object.create`, S015's unit A2 link), an accessor through
its getter, and a function's own property; when none is found the inherited Object.prototype /
Function.prototype member answers (`{"a":1}` is NaN, `[9]` is 9, `[1,2]` NaN, a function its source
text's stand-in, S015); a member that is present but not callable (`toString: undefined`) is skipped,
as in Node, so with no primitive from the other one it is the TypeError above.

**The divergences registered.**
- **(a)** (not a divergence; recorded because an earlier draft of the unit got it wrong) **Argument
  order.** Node evaluates every argument, then converts them in order, so an `any` argument's `valueOf`
  can change what a later argument reads — `let c = 10; Math.max({ valueOf() { c = 100; return 1 } }, c)`
  is 10. Where a dynamic argument precedes a non-literal one, every non-literal argument is evaluated,
  left to right, into a hidden local first, and only then converted (`lower-island.ts` lowerMathArgs).
  Nothing is refused.
- **(b) floor / ceil / trunc of a SIGNALING NaN.** Node's own answer depends on its JIT tier: the builtin
  returns the NaN's bits (`Math.floor(Math.log(-1))` is `7ff4000000000000` the first times it runs), the
  optimizing compiler's `roundsd` quiets them (`7ffc000000000000` once the function is hot; measured).
  Every lane answers the quieted bits. A quiet NaN keeps its payload on every lane and in every Node
  tier. Observable only through the bytes of a double; a signaling NaN arises only from ieee754.cc's
  `signaling_NaN()` (S100) or from bytes.
- **(c) The engine's `**` OPERATOR, native lanes under `--dynamic`.** Code the embedded engine evaluates
  itself (packages, `__island_eval`) computes `x ** y` with quickjs-ng's `js_math_pow`: the C library's
  `pow`, with the ±1 ** ±Infinity NaN but without V8's two pre-cases (`x * x` for 2, `sqrt(x + 0)` for
  0.5). The vendored engine is not modified, and the operator is not a property this tier can replace
  (its `Math.pow` is: S100). Measured on this host's glibc over 20,000,000 random bases: `pow(x, 2)`
  differs from `x * x` on 12,896 and `pow(x, 0.5)` from `sqrt(x)` on 17,399, each by one ulp. Compiled
  code's `**` is V8's on every lane (S079).
- **(d) The engine's ToNumber error text, native lanes under `--dynamic`.** An island object whose
  `valueOf` and `toString` both fail to give a primitive throws a catchable TypeError whose message is
  quickjs-ng's ("toPrimitive"), where Node's is "Cannot convert object to primitive value"; the same
  holds for any conversion the engine performs (`+obj`), and predates the Math unit. The wasm tier and a
  plain build's dyn conversion answer Node's message.

**Scope:** (a), (b) every lane; (c), (d) the native lanes in `--dynamic` builds.

**Tested by:** `packages/compiler/test/math-ieee754.test.ts` — ORDER (valueOf writing a local, a field
and an array that later arguments read; evaluation order with effects on both sides), JS (undefined,
null, booleans, strings from a .js file, plain and `--dynamic`), DYN (every member over strings, units,
booleans, arrays and objects, plain and `--dynamic`; island objects' valueOf/toString and their throws,
on every lane — (d) is why that row's failing conversion checks the error's name, not its message),
NAN ((b) pinned: every lane `7ffc…`, Node either), ENGINE (the engine's Math, which (c) leaves intact).
Corpus 2757; corpus 2781 and 2786 (the binary operators on island values — own, prototype-chain, accessor and function members — board #251, every lane). Measured against Node
v24.18.1 on x86-64.

## S109 — a module-scope binding's TDZ check on a folded `void` read inside a short-circuit or conditional branch runs before the branch is decided *(every lane)*

A file-scope `const`/`let`/`class` read before its declaration ran throws Node's
catchable `ReferenceError: Cannot access '<name>' before initialization` on
every lane (board #265; `packages/compiler/src/frontend/lowering/module-tdz.ts`).
Reads, writes and `typeof` are checked at the access itself, including reads the
lowering folds or aliases away (`late === undefined`, `void late`, a class alias).
One residue: a read that folds to the bare `undefined` value in EXPRESSION
position (`void late`) hands its check to the smallest enclosing expression, so
in `cond && void late` (or a `?:` arm) the check runs even when the branch is not
taken — where Node evaluates nothing and throws nothing, this tier throws the
ReferenceError. Statement-level `void late;` is exact. Measured against Node
v24.18.1; pinned by packages/compiler/test/module-tdz.test.ts and corpus 2765.

## S113 — Local time follows the HOST's zone: the wasm tier asks its host through `tsinter.tzCall`, the native lanes ask the C library; where the host's zone data, zone choice or DST flag differs from Node's ICU, the answers differ *(every lane; (b), (c) and (d) native only)*

**The contract.** One OS-level import, `tsinter.tzCall(op, ms, ptr, len) -> f64` (abi.ts), answers three
questions about the host's local time zone: OFFSET — the zone's offset from UTC at a UTC instant, in
milliseconds with seconds kept (Chicago before 1883 is -5:50:36, not -5:51); NAME — the zone's display
name at an instant, as Node's `Date#toString` prints it without the parentheses; ZONE — the program set
or deleted its TZ variable, so answer for that zone from now on (Node re-reads its zone whenever
`process.env.TZ` is assigned). A browser implements it in a few lines with its own `Date` and `Intl`, a C
host with `localtime_r` / `tm_gmtoff` and `setenv` + `tzset`; a host that will not answer does not supply
the import, and the module fails to instantiate with a LinkError naming it (S004's precedent); an answer
that is not an integer is the uncatchable named trap `tzCall: host failure`. Every Node rule lives in the
module (date.ts): V8's ParseDateTimeString range (a local value beyond ±(8.64e15 + 10 days) is NaN) and
DateCache::ToUTC — a local time in a DST gap or overlap takes the offset in force BEFORE the transition
(ICU's UCAL_TZ_LOCAL_FORMER, so `"2020-03-08T02:30:00"` in Chicago is 08:30Z and `"2020-11-01T01:30:00"`
is the first 01:30, 06:30Z), computed as the offset at L - max(offset a day before, offset a day after);
queries are clamped into ±8.64e15. Measured against Node v24.18.1 over every transition of 598 zones from
1850 to 2040 (570,430 local times around each transition's two edges): equal, except 19 local times on
one day — Europe/Riga, 1944-10-02 — where Node itself answers differently for the same instant
depending on what it was asked before (its DateCache; two fresh processes disagree), see (e); the
unit's review fuzz (7,448 strings over 25 zones) found the same quirk on a second Riga day, 1944-10-13.

The wasm tier reaches local time in two places: its embedded engine's Date (every engine-carrying module
imports `tzCall`; the engine's local time and its `Date#toString` name are the host's OFFSET and NAME,
under the same rules as the native engine below), and `date.parseGetTime`'s offset-less date-time (S069's
amendment): the import is minted in every module whose parse may see one — every parse site except a
string literal that carries its zone (`Z`, `±HH:MM`, ` GMT`), has no time, or has no digit, so a module
parsing only such literals needs no zone from its host — and a module that also writes `process.env`
sends ZONE when the key is `TZ`. The native lanes read the C library's zone directly
(scr_lib.c `scr_tz_offset_ms`, `scr_tz_local_to_utc`; `process.env.TZ` writes and deletes call `tzset`),
in their static parse and in their engine: the vendored quickjs-ng carries a second local patch
(vendor/README.md) routing its Date's local time through those two functions — milliseconds instead of
whole minutes (board #290's 07:14:20 vs 07:13:24), V8's ToUTC instead of a single lookup at the local
time (Lord Howe's half-hour gap and overlap), and V8's truncation toward zero for `getTimezoneOffset`
and the `GMT±hhmm` field. Its `Date#toString` name is Node's (board #283): V8 picks the zone's long
standard or daylight name by ICU's DST flag, after mapping an instant before 1970 or past 2^31 seconds
to the "equivalent" instant in 2008-2035 with the same leap-ness and January-1 weekday — which is why
Node prints Chicago in July 1800 as "(Central Daylight Time)" at a local-mean-time offset — and the
native lanes read the C library's DST flag at that same equivalent instant and look the name up in
`scr_zone_names.h`, generated from Node by `scripts/gen-zone-names.mjs`.

**Which zone a TZ value selects** is ICU's choice (TimeZone::detectHostTimeZone), not the C library's,
and both the native lanes (scr_lib.c `scr_tz_resolve`, offsets and names alike) and the harness's wasm
host (Node itself) follow it; abi.ts states it for every host. Measured under Node v24.18.1 and matched
natively for 25 TZ shapes:
- A value ICU takes as a zone name — no digit or comma before its end except at most two trailing digits,
  or one of PST8PDT MST7MDT CST6CDT EST5EDT — names the zone, less a leading `:` and a `posix/` or
  `right/` prefix: `posix/Asia/Tokyo`, `right/Asia/Tokyo` and `:Asia/Tokyo` are Tokyo (where this box's C
  library has no `posix/` directory and would answer UTC). A name the zone database lacks is a FIXED zone
  at the standard offset the C library reads from that TZ, POSIX's sign included, with no DST and the name
  `GMT±hh:mm`: `UTC+3` is -03:00, `GMT-2` +02:00, `JST-9` +09:00, `Invalid/Zone`, `foo`, `Asia/Tokyo/` and
  `TZ=` +00:00, `/usr/share/zoneinfo/Asia/Tokyo` +09:00 for all of history, and — systemd's and Docker's
  `TZ=:/etc/localtime` — the system zone's STANDARD offset all year (this box: a fixed -07:00, "GMT-07:00",
  where the C library follows America/Denver with DST; the native lanes now print Node's).
- Any other value — a POSIX rule string (`EST5EDT,M3.2.0,M11.1.0`, `<+0330>-3:30`, `UTC-05:30`) — and an
  unset TZ select the system zone, `/etc/localtime`'s resolved path below `/zoneinfo/`.
The native lanes read a chosen zone whose name differs from TZ by pointing the C library at it for the
moment of each question (tzset over a private one-entry environment), so `process.env.TZ` itself is never
rewritten.

**The divergences registered.**
- **(a) Zone DATA is the host's.** Node's offsets come from its bundled ICU (tz 2026b in v24.18.1); the
  native lanes' from the C library's tzdata (this box: 2026e, built with backzone history); a wasm host's
  from wherever its Date gets them (the harness host IS this process's Node, so the wasm lane is Node's
  exactly). Measured with the native engine over 598 zone names x 1,255 instants from 1850 to 2100: 474
  zones identical; 120 differ in offset, only where the two data sets differ — pre-1970 history of zones
  the IANA main data folds into links (Europe/Oslo, America/Nassau, ...), Canadian provinces' rules
  after 2026 (America/Winnipeg, America/Edmonton, America/Vancouver), Africa/Casablanca's.
- **(b) Names follow the C library's DST flag (native).** Where it differs from ICU's for an instant,
  the other of the zone's two names prints: negative DST in the main data format (Europe/Dublin
  1970-1971, Africa/Windhoek before 2017, Africa/Casablanca), and tzdata version differences — 13 zones
  in the measurement above, counted per zone in the generated header. The names are English: Node's
  follow the locale (`LANG=de_DE.UTF-8` prints "(Mitteleuropäische Normalzeit)"), the native lanes
  print the en-US name under every locale.
- **(c) Zone CHOICE (native), what remains.** The choice above is mirrored; what is not: a zone name the
  C library's zone directory has but ICU lacks (or the reverse) — the native lanes decide "known" by the
  zone FILE (TZDIR, else /usr/share/zoneinfo), ICU by its own list; an `/etc/localtime` that is a copy
  rather than a link, where ICU searches zoneinfo for the matching file and the native lanes keep the C
  library's zone with a `GMT±hh:mm` name; and ICU's 3-4-letter abbreviation check (a known short name whose
  standard offset disagrees with the C library's is dropped), not modelled.
- **(d) Windows (native).** The CRT's zone: TZ is not IANA-shaped and there is no history before 1970
  (offset 0 there). Corpus 2771 is on the Windows lane's skip list.
- **(e) Node's own cache.** V8 answers UTC-to-local offsets through its DateCache, which can answer a
  different offset for the same instant depending on the queries before it (measured: Europe/Riga,
  1944-10-02T01:00Z, +3:00 after a forward scan, +1:00 in a fresh process; 1944-10-13 behaves the same). Every lane answers the zone
  data's offset; a program reaching such an instant can differ from Node, as Node can differ from
  itself.
- **(f) The clamp.** The wasm tier asks about instants in ±8.64e15 only; a local time within a day of the
  range's edge takes the offset at the edge, which differs from Node only if a zone transition fell in
  that day (measured: no zone of the 598 changes offset within two days of either edge in Node's data).

**Tested by:** `tests/harness/tz-matrix.test.ts` (a static program and an engine program, each on c,
llvm and wasm, against Node, under 23 TZ values: Chicago, Kolkata, Lord Howe, London, UTC,
St John's, Chatham, Kathmandu, an invalid name, the empty string, unset, and the shapes of the choice
above — `posix/` and `right/` and `:` prefixes, `:/etc/localtime`, a zoneinfo path, `UTC+3`, `GMT-2`,
`JST-9`, `<+0330>-3:30`, a POSIX rule string, `EST5EDT`, `Asia/Tokyo/`); `packages/compiler/test/
wasm-date.test.ts` (local rows against this process's Date under seven zones, the import-section pins —
a zoned or date-only literal imports nothing — the OFFSET bound and integer traps, the ZONE answer trap,
the ZONE op's order, a 200,000-unit TZ value); corpus 2771 (the program sets its own zones). Broken once by
hand: the max of the two offsets turned into a min (static rows red, wasm included), the engine hook
rounded to minutes and the name table's daylight column ignored (engine rows red), the `posix/` strip
dropped (the `posix/` and `right/` rows red).

## S108 — The island's web-platform globals are one shared set of ports of Node's own classes on every lane; what parts from Node: `console` prints through Node's own util.inspect (S114's residue aside) and fences the wall-clock and V8-stack methods, `TextDecoder` decodes UTF-8 only, the streams are a subset whose promise jobs interleave differently, MessagePort delivery and WebCrypto are fenced, Node globals outside the set are fenced by name on every lane, `performance` carries `now` and `timeOrigin` only, a throwing event listener is reported later, and the engine's own builtins differ where listed *(every lane: the c and llvm lanes' island and the wasm lane's engine)*

The globals island code sees beyond the engine's own builtins — `console`,
`TextEncoder`, `TextDecoder`, `TextDecoderStream`, `URLSearchParams`,
`btoa`/`atob`, `ReadableStream`, `TransformStream`, `Headers`, `Blob`,
`File`, `Event`, `EventTarget`, `CustomEvent`, `DOMException`,
`AbortController`/`AbortSignal`, `structuredClone`, `MessageChannel`/
`MessagePort`/`MessageEvent`, `Request`/`Response`, `Crypto`/`crypto`,
`SubtleCrypto` and the timer functions — come from ONE JavaScript text,
`packages/runtime/src/scr_web_prelude.js` (rendered into the C literal
`scr_web_prelude.h` by `scripts/gen-web-prelude.mjs`; a unit test holds the
two together and another fails when `engine.wasm`'s copy is stale),
evaluated at engine boot by the native island (`scr_web.c`) and by the wasm
lane's engine (`isl_core.c`). Each lane implements only the host functions
the text calls (an fd write, entropy, the zone name, timers, and three
internal-slot checks — is a promise, is a proxy, a proxy's target), so both
lanes answer every row the same way. The classes are ports of Node
v24.18.1's own code — `lib/internal/encoding.js`, `url.js` with
`querystring.js`, `per_context/domexception.js`, `event_target.js`,
`abort_controller.js`, `errors.js` and `validators.js` for the error
shapes, `util/inspect.js`'s `formatWithOptions`, `buffer.js` with simdutf's
base64 order of checks, undici's `Headers`, V8's `ValueSerializer` for
`structuredClone` — with every bit of internal state private (WeakMaps and
private fields; nothing a program can read, enumerate or clobber), so their
answers, argument checks, error classes, codes and messages,
`Symbol.toStringTag`s, iterator objects, constructor lengths, the
prototypes' members and their enumerability, and the globals' property
shapes are Node's, except where (c), (h) and (k) say otherwise;
`tests/harness/web-globals.test.ts` compares those rows with Node live, on
the native and the wasm lane, and corpus 1120 runs the encoders under both.
Where the island parts from Node, measured against Node v24.18.1:

- **(a) `console` is Node's, over Node's util.inspect.** There is ONE
  console on every island build and lane: `log`/`info`/`debug`/`dirxml`
  (stdout) and `warn`/`error` (stderr) are Node's `formatWithOptions`
  branch for branch — every specifier (`%d`/`%i`/`%f` run
  `Number`/`parseInt`/`parseFloat` over objects too, `%s` takes `String()`
  of an object with its own `toString`, `%j` prints `[Circular]`) — and
  `group`/`groupCollapsed`/`groupEnd`, `count`, `countReset`, `assert`,
  `clear`, `profile`, `profileEnd` and `timeStamp` are Node's; writes go to
  the stream static output uses, in order with it, lone surrogates as
  U+FFFD. Where Node calls `util.inspect` (an object or a function as a
  plain argument, `%o`/`%O`, `%s` with an object whose `toString` is a
  builtin, `console.dir`, `console.table`), the island calls Node's own
  `lib/internal/util/inspect.js`, ported function for function into the
  shared prelude (with `cli_table.js` for `table`) — every option
  (`depth`, `showHidden`, `showProxy`, `colors`, `compact`,
  `breakLength`, `sorted`, `getters`, `maxArrayLength`,
  `maxStringLength`, `numericSeparator`, `customInspect` and the
  `util.inspect.custom` hook), class instances, null prototypes,
  accessors, symbols, circular references, holes, truncation and line
  breaking, Maps, Sets, typed arrays, buffers, dates, regexps, errors
  with their causes, boxed primitives, functions and classes, proxies,
  promises and weak collections — with what parts from Node registered in
  S114. `%s` of a builtin or bound function prints its
  `Function.prototype.toString`, which is QuickJS's three-line native form
  (`function max() {⏎    [native code]⏎}`; V8's is one line — (j)). The same inspector is `util.inspect`/`util.format`/
  `util.formatWithOptions`/`util.stripVTControlCharacters` in an npm
  build's `node:util` (the bootstrap's own port is gone), and quotes the
  values in the error messages Node builds with it (webidl's `Expected
  eventInitDict.source ("{}") …`, `ERR_ARG_NOT_ITERABLE`'s `{} must be
  iterable`, `ERR_INVALID_ARG_TYPE`'s `Received …`). The console never
  colors (Node colors a TTY; S114). The methods that are nothing but
  wall-clock time, V8's stack or Node's classes — `time`, `timeEnd`,
  `timeLog`, `trace` (Node prints a V8 stack), `Console`, `context`,
  `createTask` — and `countReset` of a label never counted (Node reports
  it through a process warning) throw a named `Error` (`console.<name>
  inside the scriptc island is not supported yet (SEMANTICS.md S108)`).
- **(b) `TextDecoder` decodes UTF-8 only.** Node's six UTF-8 labels decode;
  every other label in Node's table throws `RangeError: the scriptc
  island's TextDecoder supports utf-8 only (got 'latin1')` where Node
  decodes; the six labels of the "replacement" encoding and an unknown
  label are Node's `ERR_ENCODING_NOT_SUPPORTED`. `TextEncoderStream` is
  fenced by name ((d)).
- **(c) The streams are a subset.** `ReadableStream` (with `from`),
  `TransformStream` and `TextDecoderStream`: `type: 'bytes'`, BYOB readers,
  `tee()` and `pipeTo()` throw named errors; `Request`/`Response`
  `clone()` and `formData()` throw one too; by the implementation's
  design, not pinned here, queuing strategies are accepted and ignored (a
  high-water mark of 1) and a transform runs eagerly on write. The
  readers, writers and controllers are plain objects carrying the right
  members and toStringTags, not instances of Node's (unexposed) classes.
  Their promise jobs take different numbers of microtask turns than
  Node's, so independent async chains interleave differently. Measured
  with four evals in one tick — one awaiting `Response.text()`,
  `Response.json()`, `Blob.arrayBuffer()` and `Blob.text()` in turn, one
  `for await` over a `ReadableStream`, one reading a `TransformStream`,
  one reading a `TextDecoderStream` — the lines print in the order
  resp.text, tds, ts, json, blob, rs, blobtext on every lane; Node's is
  resp.text, json, blob, rs, tds, blobtext, ts. Each chain's own result is
  Node's.
- **(d) Node globals outside the set are fenced by name on every lane.**
  What neither the engine nor the set (nor the build's npm or fetch boot)
  provides is S103 (b)'s fence on the native lanes too: in a plain
  `__island_eval` program, 38 names (S103 (b)'s 43 less the four timers
  and `Atomics`, which the native engine has), among them `URL` (until an
  npm package or a URL value installs it), `fetch`, `process`, `global`,
  `Buffer`, `WritableStream`, `FormData`, `WebSocket`, `Intl`,
  `WebAssembly`, `navigator`, `setImmediate`, `TextEncoderStream`,
  `CompressionStream`, `CryptoKey` and the performance classes.
- **(e) The zone name in `Date#toString`.** The text appends Node's
  parenthesised zone name to `toString` and `toTimeString` through the
  host's `tzname`: the native lanes answer S113's name for the zone at that
  instant (Node's own table, `scr_zone_names.h`), the wasm lane's engine
  the name its host answers through `tsinter.tzCall` (S113).
- **(f) Timers on the native lanes** share the static timer heap; the
  returned object's `unref()` is accepted and not honoured, and its
  primitive value is the heap's id, not Node's async id. The wasm lane
  fences the timers (S103 (b)).
- **(g) WebCrypto is not carried.** `SubtleCrypto` has Node's shape (illegal
  to construct, its methods on the prototype, `crypto.subtle` its
  instance), but every method — and `SubtleCrypto.supports` — throws a
  named `Error` synchronously (`crypto.subtle.<name> inside the scriptc
  island is not supported yet`) where Node returns a promise.
  `getRandomValues` and `randomUUID` are Node's, errors included.
- **(h) MessagePort delivery is fenced.** `postMessage` queues a
  `structuredClone` copy, which worker_threads' `receiveMessageOnPort`
  drains as in Node; but Node delivers queued messages as `'message'`
  events on a later macrotask, which the island has no task source for, so
  every way to start delivery — `start()`, the `onmessage` and
  `onmessageerror` setters, a `'message'`, `'messageerror'` or `'close'`
  listener (`addEventListener`, `on`, `once`, `addListener`) — throws a
  named `Error` (`MessagePort … is not supported in the scriptc island (no
  task source delivers port messages)`), and `close()` fires no `'close'`
  event. `MessagePort`'s prototype therefore carries its own
  `addEventListener`, `on`, `once`, `off`, `addListener` and
  `removeListener` above `EventTarget` (Node: `NodeEventTarget` between
  them), and `MessageChannel`/`MessagePort` are classes (Node's are
  functions, with own `arguments`/`caller`). `postMessage` itself is
  Node's (`src/node_messaging.cc`): the second argument is a transfer
  list or an options bag with `transfer`, checked with Node's
  `ERR_MISSING_ARGS`/`ERR_INVALID_ARG_TYPE` texts, and the ArrayBuffers it
  lists are detached once the clone succeeds, on a closed port too.
- **(i) The engine's own builtins.** What quickjs-ng has and Node 24 does
  not is removed at boot (the `InternalError` global, `Function.prototype`
  `fileName`/`lineNumber`/`columnNumber`, `Math.sumPrecise`,
  `Map`/`WeakMap` `getOrInsert`/`getOrInsertComputed`, the immutable
  `ArrayBuffer` methods, `Uint8Array` base64/hex, `Iterator.concat`/`zip`/
  `zipKeyed`); what Node has and the engine lacks — RegExp's legacy static
  match properties (`RegExp.$1`…`$9`, `input`, `lastMatch`, …) and
  `Atomics.waitAsync` — throws a named `Error` on read and write. An
  error's `stack` is QuickJS's: ONE accessor on `Error.prototype` (V8 13.6:
  an own accessor on each error, none on the prototype) whose text is
  QuickJS's frames without V8's opening `name: message` line. Its setter
  stores any value the way V8's does — on a frozen or non-extensible
  error too, and for an object with an error on its prototype chain (the
  value is read back through that object, which gets no own property);
  assigning to an object that only inherits `Error.prototype` makes an own
  enumerable property, V8's ordinary assignment. What differs is
  ownership: `Object.getOwnPropertyNames(new Error('x'))` is `message`
  (Node: `stack,message`), `Object.hasOwn(e, 'stack')` is false before and
  after an assignment (Node: true), its descriptor is `undefined` (Node: an
  accessor), `delete e.stack` leaves `e.stack` readable (Node:
  `undefined`), and the setter called directly on a primitive throws
  `TypeError: not an object` (Node has no prototype setter to call). The
  engine's own error messages
  are QuickJS's (`cannot convert symbol to string`; Node: `Cannot convert
  a Symbol value to a string`; S103 (d)).
- **(j) `structuredClone`** is V8's serializer over the island's values:
  one identity memo (shared and cyclic references, two views of one
  buffer), the primitive wrappers, `Date`, `RegExp` (source and flags),
  `Map`, `Set`, `ArrayBuffer` (resizable ones keep `maxByteLength`), typed
  arrays and `DataView` as views onto the cloned buffer, arrays with their
  holes and extra properties, errors as V8 writes them, everything else a
  plain object of its own enumerable properties (prototypes dropped), and
  Node's answers for its own host objects (`Blob`/`File`/`DOMException`
  clone; `Headers`/`URLSearchParams`/`Request`/`Response` are
  "unsupported"; `MessagePort`/`ReadableStream`/`TransformStream` need a
  transfer list) — `DataCloneError` with V8's `<value> could not be
  cloned.` for functions, symbols, the Symbol wrapper, weak collections,
  promises, generators, built-in iterators, proxies, arguments objects and
  the global object; a transfer list moves `ArrayBuffer`s as Node does
  (the clone owns the bytes, the source is detached; Node's duplicate,
  detached and non-transferable errors). As V8 does, it snapshots an
  object's own enumerable keys and a `Map`'s or `Set`'s entries before
  cloning any of them (a key a getter deletes meanwhile is skipped, an
  entry it adds is not cloned, one it deletes still is), clones a packed
  array element by element (an element deleted meanwhile is a hole, a
  named property added meanwhile is cloned) and any other array by its
  snapshotted keys, creates each property rather than assigning it (no
  setter runs, `__proto__` stays an own key), refuses a view out of
  bounds of its shrunk resizable buffer (a typed array as `[object
  Object] could not be cloned.`, a `DataView` as `#<DataView> …`), and
  refuses a `MessageEvent` as unsupported. A function's text in the
  message is the engine's `Function.prototype.toString` — QuickJS's
  three-line native form (`function max() {⏎    [native code]⏎}`; V8: one
  line), which island functions take too, since the island keeps no
  source (S019). Not carried: a `SharedArrayBuffer`
  throws a named `Error` (Node shares it), and so does a port or a stream
  in a transfer list (Node transfers them).
- **(k) Smaller shape differences.** `Request.prototype` lacks undici's
  stray `attribute` member; Request's fetch-only attributes (`cache`,
  `credentials`, `mode`, …) answer Node's defaults and are read-only
  constants. The island's web text carries no WHATWG URL parser, so a
  `Request`'s URL and `Response.redirect`'s are checked for a scheme only:
  without one they fail as Node's do (`TypeError: Failed to parse URL from
  /rel`, its cause `ERR_INVALID_URL`), with one they are kept as written —
  `new Request('http://a').url` is `http://a` (Node: `http://a/`), and a
  string Node's parser rejects past the scheme (`http:`) is accepted.
  Node's instances carry symbol-keyed internal slots
  (`Object.getOwnPropertySymbols` lists 4 on an `Event` and on an
  `EventTarget`, 3 on a cloned `Blob`); the island's carry none. A
  `DOMException` has no own `stack` ((i): the engine's stack is an
  inherited accessor). `Event#timeStamp` is Node's `performance.now()` —
  the host's monotonic clock, in ms since the process started (natively
  the static `performance.now`'s clock; on the wasm lane the module's
  `now` import, which the differential test host serves as a virtual
  clock that reads 0).
- **(l) A throwing event listener** is reported after the dispatch as an
  uncaught exception thrown from an engine job (the island's uncaught
  report, S103 (c)), where Node throws it on `process.nextTick`; the other
  listeners still run, as in Node. A `null` or `undefined` listener is
  ignored as in Node, but without Node's
  `AddEventListenerArgumentTypeWarning` on stderr (the island has no
  process warnings).
- **(m) `performance`** is an object with `now()` and `timeOrigin` only
  (Node's is a `Performance` with marks, measures, `toJSON`,
  `eventLoopUtilization` and more; the island's npm `node:perf_hooks`
  adds inert ones). `now()` reads the static side's clock — the native
  lanes' `scr_perf_now`, the wasm module's `perf_now` import — so island
  and static readings at the same instant agree, as in Node (the
  engine's own object counted from its context's creation); `timeOrigin`
  is that origin as an epoch time. Neither is an own enumerable key,
  as in Node.

**Tested by:** `tests/harness/island-inspect.test.ts` — (a)'s inspector
and console against Node live on the c, llvm and wasm lanes (every lane
byte-identical, engine frames included; Node with frames set aside), with
S114's residue rows and the fences; `tests/harness/web-globals.test.ts` — every row on the
native and the wasm lane, most compared with Node live in the test process
(URLSearchParams; `structuredClone`'s kinds, identities, views, wrappers,
prototypes, errors and refusals; `Headers`; base64, `crypto` and
`DOMException`; the encoders and labels; `Event`/`EventTarget`/
`AbortSignal` behaviour and privacy; the classes' shapes; the
toStringTags; the globals' shapes; the removed builtins; `console`'s
formatting of every specifier, grouping, counting, assertions and U+FFFD,
against `node -e`; island jobs at the exit checkpoint), and the fences of
(a), (b), (c), (g), (h) and (i) by message; the npm differential's
`console-npm` case (stdout and stderr against Node: the one console in an
npm build); the E2 rows of `packages/compiler/test/wasm-island-engine.test.ts`
(the header and the artifact against the `.js`, `console`'s stream order,
`crypto` through the module's `random` import, the timer fences); corpus
1120 on the c, llvm and wasm lanes against Node. (c)'s interleaving, (d)'s
list and (e) were measured by hand, outside the suite.

## S114 — The island's util.inspect is Node's own, ported; what parts from Node: an error prints the engine's stack frames, `%o`/showHidden lack V8's own `arguments`/`caller`/`stack` members, a null-prototype object V8 can still name after its class prints `Object` and a function's kind is read from its prototype, a Map or Set iterator and showHidden over a weak collection throw a named Error, the console never colors, and inspection gives up past 100 levels of nesting on every lane *(every lane: the c and llvm lanes' island and the wasm lane's engine)*

S108 (a)'s inspector is Node v24.18.1's `lib/internal/util/inspect.js`
(and `cli_table.js` for `console.table`), ported function for function
into the shared prelude (`scr_web_prelude.js`) over primordials captured
at boot, so every lane runs the same code and prints the same bytes.
What V8 answers from internal slots comes from the intrinsics' own brand
checks (Map/Set `size`, Date `getTime`, RegExp `source`, the typed-array
tag, the boxed-primitive `valueOf`s, `Error.isError`) or from the host
(`promiseState`, `proxyTarget`/`proxyHandler`, `isPromise`/`isProxy`, and
`classId` — the engine's class of an object, compared with the classes
of a real Map iterator, Set iterator, arguments object and module
namespace, so none of these can be faked by a prototype or a
`Symbol.toStringTag`: `scr_web.c` and `wasm/isl_core.c`, the same host
functions over the same engine API); a `Symbol.toStringTag` getter is
read once, guarded, as in Node. String widths — which decide how arrays group into columns and
how `console.table` pads — are Node's ICU `GetStringWidth` (ambiguous
as narrow, emoji sequences expanded) from a table generated out of
Node's own ICU (`scripts/gen-string-width.mjs`: ICU 78.3, Unicode 17.0;
`--check` holds the table to the running Node) after NFC, as Node does;
the NFC is the engine's own `normalize`, whose Unicode tables are
quickjs-ng's, so a code point whose normalization changed in a Unicode
version the engine predates can measure differently (not measured).
Everything else is Node's, except:

- **(a) An error prints the engine's stack frames.** The engine's
  `stack` is its frames alone (S108 (i)); an error whose stack is still
  the engine's own prints as V8 would have written it — the `name:
  message` header V8 formats at the FIRST read of the stack (the island
  records it at the first read of `stack` through its accessor, or at
  this print if none came first; a `name` or `message` getter that throws
  makes that read throw, so the error prints `[object Error]`, as in
  Node), then the frames — and goes through Node's formatError (brackets
  when there are no frames, the class prefix, `[cause]`, `[errors]`, own
  extra properties). The frames are QuickJS's: `    at <name>
  (<island>:<line>:<column>)`, one per engine frame, positions the
  engine's (a constructor's own frame is listed; Node's eval frames name
  the eval site), so Node's collapsing of frames shared with a cause
  (`... N lines matching cause stack trace ...`) and of repeated frames
  happens over different lines. A stack a program assigned prints as it
  is, as in Node. The frames are the same on every lane: the wasm lane
  evaluates `__island_eval` under the native lanes' file name with no
  frame for `eval` (S103).
- **(b) `%o` and showHidden see the engine's object shapes.** A sloppy
  function lacks V8's own `[arguments]: null` and `[caller]: null` (the
  engine's sit on `Function.prototype`), and an error lacks `[stack]:
  [Getter/Setter]` (S108 (i): one accessor on `Error.prototype`).
- **(c) Names V8 reads from an object's map.** An object whose prototype
  was replaced keeps, in V8, the constructor that built it:
  `Object.setPrototypeOf(new Foo(), null)` prints `[Foo: null prototype]
  {}` in Node and `[Object: null prototype] {}` here; V8's
  GetConstructorName is otherwise followed as far as JavaScript can (a
  string `Symbol.toStringTag` data property, then a named `constructor`
  above the object, then the object's class). A function's kind
  (async, generator) is read from its intrinsic prototype, so a function
  whose prototype was replaced prints as a plain `[Function]`.
- **(d) What V8's previewEntries reads is fenced.** The entries a Map or
  Set iterator has left (`console.log(map.entries())`,
  `console.table(map.keys())`) and the entries of a WeakMap or WeakSet
  under showHidden (`%o`, `{ showHidden: true }`) have no JavaScript
  view without consuming or holding them; inspecting one throws a named
  `Error` (`util.inspect of a Map iterator's entries inside the scriptc
  island is not supported yet (SEMANTICS.md S114)`, likewise `a Set
  iterator`, `a WeakMap`, `a WeakSet`) where Node prints them. A weak
  collection without showHidden prints Node's `<items unknown>`.
- **(e) The console never colors.** Node's console colors its output when
  the stream is a terminal that supports color; the island's never does
  (`util.inspect`'s `colors` option is Node's).
- **(f) One nesting cap.** Node inspects nested objects until V8's stack
  runs out (`console.dir(o, { depth: Infinity })` of a chain 1,000–1,500
  deep, measured) and prints that level as `[Object: Inspection
  interrupted prematurely. Maximum call stack size exceeded.]`; the
  engines' stacks run out at different depths per lane (the wasm
  engine's at 100–300 levels, measured), so the island gives up at the
  SAME depth on every lane — past 100 levels of nesting — with Node's
  text (`kMaxInspectNesting` in `scr_web_prelude.js`; S029 is the static
  tier's counterpart). A structure 101 or more levels deep printed with
  an unbounded `depth` therefore stops sooner than in Node; the default
  `depth` of 2 never reaches it.

Booting the inspector costs every island program about 5 ms (a trivial
`__island_eval` native c binary: median 8.5 ms before, about 13.5 ms
after, measured in review; the implementer's 30-run means were 10.6 and
13.4 ms) and the wasm engine about 100 KB (engine.wasm 970,267 →
1,070,405 bytes).

**Tested by:** `tests/harness/island-inspect.test.ts` — a matrix of
values (primitives, strings and escapes, nesting, holes, long and
grouped arrays, wide characters, keys, accessors, Maps, Sets, typed
arrays, buffers, dates, regexps, boxed primitives, functions, classes,
toStringTags, null prototypes, circular structures, promises, proxies,
arguments, weak collections, custom inspectors) through `console.log`,
`%s`/`%O`/`%o` and `console.dir` under every option, errors, the format
specifiers, `dir`/`dirxml`/`table`/`group`/`assert`, and the error
messages that quote values — against Node live, every lane byte-identical
to the others (frames included) and to Node with frame lines set aside;
(a)'s header timing (a throwing `name` getter, a message changed before
and after the first read) and the brands a program cannot fake against
Node; (b), (c) and S108 (j)'s `%s` of a native function as residue rows
(lane-identical, Node differing by exactly the registered text); (d) by
message on every lane; (f) by the cap's text at 101 and 2,000 levels and
none at 100, identical on every lane. The class-id brand was also broken
by hand (a prototype compare again): the brands row went red. Broken
once by hand (breakLength 128 for Node's 80; the native fence call
removed): every group and the fence row went red.

## S116 — regex results and values around the lastIndex model: `.index`/`.input` of a GLOBAL match() result and a global/sticky regex VALUE crossing into dynamically-typed code throw named Errors where Node answers; an exec/match result prints without its `index`/`input`/`groups` *(every lane)*

Board #301 modelled lastIndex (S003's regex amendment). What it leaves:

(a) **Companions, and the every-match array.** A match result is the
honest `string[]` row (S064); its `.index`, `.input` and `.groups` live
in hidden COMPANION locals of the binding it is assigned to
(`frontend/lowering/lower-regex.ts`) — a binding every write of which is
a direct `re.exec(s)` / `s.match(re)` call, or null, inside its declaring
function (`while ((m = re.exec(s)) !== null) { m.index … }`, `const m =
s.match(re); if (m) m.input`). Anywhere else (a result passed to a
function, stored in a container, read in a closure) those reads keep
their compile-time fence by name — a refusal, not a divergence. The refusal's
hint says which rule the binding broke. A GLOBAL regex's `match()`
answers the every-match array, which in Node has no `index` or `input`
(they read `undefined`): when every write to the binding is a `match()`
over a statically global regex, reading either refuses at compile time;
when the shapes mix (a global and a non-global match, or a regex the
compiler cannot see), reading either after a global match throws a named
Error at run time ("'.index' of a global match() result (Node:
undefined) is not supported …") — the one divergence here — instead of
answering a number or a string the IR's `number`/`string` types cannot
make undefined.

(b) **A regex VALUE crossing into dynamically-typed code** (an `any`
slot, an npm package call, a JS function's untyped parameter) is rebuilt
there as a fresh engine RegExp from its source and flags
(`islandRegexpOf`), where Node passes the same object — so lastIndex
would neither cross nor come back. Since lastIndex is observable now, a
crossing value that is global or sticky (whose methods move lastIndex on
either side), or whose lastIndex is not 0, throws a named Error at the
crossing ("passing a global or sticky RegExp value … into dynamically-
typed code is not supported …"); a regex LITERAL crossing directly is a
fresh object in Node too and crosses as before. A non-global,
non-sticky value crosses with lastIndex 0 on both sides; only an
explicit `lastIndex` WRITE on the engine side would then differ (the
wasm island fences member writes on its RegExp — unit F1's amendment).

(c) **Printing a match result.** `console.log(re.exec(s))` /
`util.inspect` print the row's elements only — `[ 'a', 'a', '' ]` — where
Node prints the array's own `index`, `input` and `groups` properties too
(`[ 'a', 'a', undefined, index: 1, input: 'xay', groups: undefined ]`;
the `''` is S064). PRE-EXISTING (it predates board #301 on every lane)
and SILENT: recorded here when this unit measured it, and reported for
its own fix — the row has no slot for the properties, so the fix is a
representation question (the companions are per binding, not per
value).

**Tested by:** (a) the companion reads are exercised by corpus 2795 and
the regex state fuzz on all three lanes; the global-match throw and (b)'s
throw were measured by hand on wasm, c and llvm (the crossing:
`const re = /a/g; re.lastIndex = 3; f(re)` with an untyped JS `f` —
Node 3, every lane the named Error). (c) is measured, not pinned (a
corpus program cannot pin a divergence it fails on by construction).

## S110 — island values print; island-array edge cases *(llvm, c and wasm under `--dynamic`; (c) the llvm and c lanes; (e), (f) per lane)*

`any[]` and the composites holding `any` ARE island values and never copy
(S014's unit-H amendment). How TYPED composites (`string[]`, `number[]`,
records, tuples) cross is S115's subject: shared as live views into the
island, and out of it only when fresh. (a) and (b) of this entry — the
copy-observability analysis that refused observed copies and registered
the rest — are retired with that model (follow-up unit H).

- **(c) An island array's own errors on the llvm and c lanes.** The
  island glue restores V8's texts for `reduce`/`reduceRight` of an empty
  array, `with` out of range (`Invalid index : <argument>`) and a
  non-function `sort`/`toSorted` comparator. Other Array.prototype
  errors keep quickjs-ng's wording: a non-callable callback says `not a
  function` (V8: `xs.push is not a function`, `number 3 is not a
  function`). Code `__island_eval` runs on the wasm lane keeps
  quickjs-ng's texts throughout (S103).
- **(d) A read the checker types as a primitive exits validated.** With
  `xs: any[]` holding a non-array at run time (only a lying annotation or
  cast can do that), `xs.length` and the like throw `TypeError: expected
  number, got undefined` where Node reads `undefined`.
- **(e) Printing island values.** `console.log`, `util.format`'s
  specifiers and `util.inspect` render plain data as Node does on every
  lane — on wasm through the dyn walker (an island value IS a dyn value
  there), on the native lanes through a read-only snapshot of the engine
  value (dense Arrays with Array.prototype; objects with Object.prototype
  or a null prototype holding only enumerable string-keyed data members;
  primitives; a typed composite's VIEW, read through its compiled
  accessors — S115). Any other engine shape — a function, a class
  instance, an accessor, a hole, a symbol key, a cycle, a BigInt or
  symbol value, any other Proxy — keeps the loud `util.inspect of a
  composite 'any' value (typeof '<t>') is not supported yet` TypeError on
  the native lanes, while wasm renders what its walker renders (a
  function prints `[Function (anonymous)]` where Node names it — the
  island crossing does not carry function names, a wasm-lane gap that
  predates this unit).
- **(f) Island arrays on the wasm lane.** The vector is dense (S016):
  a write past an island array's length — where Node leaves holes —
  throws a catchable `Error: writing an island array at index <k> past
  its length (the holes Node leaves) is not supported yet on the wasm
  lane`, and growing its `length` throws `Error: growing a dynamic
  array's length past its elements (the holes Node leaves) is not
  supported yet on the wasm lane` (shrinking it truncates, as in Node;
  the native engine has holes and answers as Node; the checked-dynamic
  `unknown` index write keeps S016's padding). Index arguments of the
  Array methods run ToNumber for strings, booleans and null; an object
  index (ToPrimitive) is a named `non-number index arguments on a dynamic
  receiver` TypeError. `keys`, `values`, `entries`, `toSpliced`,
  `copyWithin` and `toLocaleString` on an island array are named
  `'Array.prototype.<m>' on a dynamic value is not supported yet` Errors.
  A comparator's CALL SEQUENCE (how many calls, which pairs) is the merge
  sort's, not V8's (S024).

**Tested by:** `packages/compiler/test/wasm-any-array-shared.test.ts` —
H-B2, H-S2 and H-S2b ((f), wasm and c), H-S3, H-S110c (wasm and c),
H-INSPECT-01, H-VIEW-INSPECT ((e) for views); `tests/harness/dyncheck.test.ts`
((e)); the `wasm-emitter.test.ts` jsExit pin ((d)). Measured against Node
v24.18.1.

## S115 — a TYPED composite is SHARED with dynamic code (`any` and `unknown` alike) as a live view, whose writes must fit the declared types and shape; a dynamic value enters typed storage only when it is fresh or its own view — every other exit, typed callback parameters and package results included, is refused at compile time *(llvm, c and wasm under `--dynamic`; (c) per lane)*

Joe's ruling D2 as approved 2026-10-26 (follow-up unit H, boards
#259/#268). Node has one object on both sides of every assignment; this
tier keeps typed composites (`string[]`, `number[]`, records, tuples, and
unions carrying them) in typed storage, which an engine value cannot be.
`unknown` crosses exactly like `any` under `--dynamic` (a typed value
entering an `unknown` slot is its view, wrapped; an `unknown` value
leaving into typed storage follows (d)). So:

- **(a) LIFTS share: a typed composite entering an `any` slot is a live
  VIEW of the static value, never a copy.** Assignments, arguments,
  returns, object-literal members, array elements, `Object.assign`
  sources, a compiled function's typed result handed to dynamic code (its
  view — or, when every return builds a fresh array of shared elements
  such as `ps.slice()`, a fresh island array of the elements' views; a
  result fresh all the way down crosses as a plain copy) — every way a
  typed array, tuple or record reaches `any` / `unknown` / `any[]` / an
  island member. (An array or object LITERAL lifted straight into an
  `any` slot is fresh, so it is built as the island literal Node builds —
  no view, no type lock — its non-literal parts crossing as views. A
  template literal's strings array, frozen in JS, crosses as a FROZEN
  view whose writes throw Node's strict-mode TypeErrors — S080's
  amendment.)
  Reads through the view box the typed value
  as it is NOW; writes land in the typed storage; nested composites read
  as their own views. Identity is exact: two crossings of one static
  value are one JS value (`===`, `indexOf`, `includes`). The view is an
  ordinary array (`Array.isArray` true; arrays and tuples) or object
  (records) to everything the island does — Array methods, spread,
  `JSON.stringify`, printing, `Object.keys`. The accessors are compiled
  per static type by the front end and are the same code on every lane:
  on the llvm and c lanes the container is an engine Proxy over an
  empty Array or object, cached per static value while it lives; on
  wasm it is a dyn array/object box carrying the static value.
- **(b) A write through a view must fit the static type; the shape is
  fixed.** Each refusal is a catchable error where Node succeeds:
  - a value of the wrong primitive kind: `TypeError: Cannot store
    <typeof> into <container> shared from typed code (it holds <kind>
    only — SEMANTICS.md S115)` (`<container>` is e.g. `a 'number[]'
    element`, `the 'x' field of a '{ x: number }'`);
  - an island value into a nested typed slot that is not a view of
    exactly that slot's type (a fresh `{...}` or `[...]` included — the
    copy would be unobservable only when nothing else holds it, which no
    run-time check can see): `TypeError: Cannot store object into ... (a
    'T' slot takes only a value shared from a typed 'T') (SEMANTICS.md
    S115)`;
  - a member a record does not declare: `TypeError: Cannot add property
    'k': a 'T' shared from typed code has a fixed shape`; a non-index
    member on an array view likewise; a `Record<string, T>` /
    index-signature record takes new keys of its value type;
  - holes: an index write past the end (`Error: Writing past the end of
    a 'T[]' shared from typed code would leave holes, ...`), growing
    `length` (`Error: Growing the length of ...`); shrinking `length`,
    `pop`, `shift`, `splice` and the like work; deleting the last element
    truncates, any other element delete throws;
  - a tuple's length is fixed: any write changing it throws `Error: a
    '[...]' shared from typed code is a tuple: its length is fixed`;
  - a slot of a union type takes what the validated exit takes, and
    anything else throws its `expected <T> at $, got <kind>` TypeError; a
    slot of a type that cannot leave the island at all (a bytes-or-string
    union) throws `Cannot store into ... a '<T>' slot cannot be written
    from dynamic code yet`;
  - in engine code on the llvm and c lanes (compiled code cannot spell
    these on `any` — they refuse at compile time on every lane):
    `Object.freeze` / `seal` / `preventExtensions`, `Object.defineProperty`
    with anything but a plain writable value, deleting an element other
    than the last (deleting the last truncates), deleting a record
    member, and `Object.setPrototypeOf` throw named TypeErrors; the wasm
    lane refuses `Object.defineProperties` onto a view outright.
  A mutating Array method that throws part way (a wrong-typed element
  pushed by `splice`) leaves the elements before the failing one written.
- **(c) Per lane.** On wasm, index reads and writes, `length`, `push`
  and `pop` go straight to the view's accessors, and the callback walkers
  (`forEach`, `map`, `filter`, `some`, `every`, `find`, `findIndex`,
  `findLast`, `findLastIndex`) walk the view LIVE as Node does — each
  step reads the element at that moment (a write from the callback, through
  the view or straight to the typed array, is seen where Node sees it),
  skipped indices follow HasProperty/Get as in Node, and the callback's
  third argument is the view. The other Array methods run over a
  snapshot taken at the call and write a mutated snapshot back through
  the accessors (`shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`
  are O(n) per call, as in V8; `copyWithin`, `keys`, `values`,
  `entries`, `toSpliced` and `toLocaleString` are the named `'Array.prototype.<m>'
  on a dynamic value is not supported yet` Errors of S110 (f)); `reduce`, `reduceRight` and `flatMap`
  walk that snapshot, and one whose callback changed the view meanwhile
  throws `Error: a '<m>' callback changed ... while the method walked it,
  which the wasm lane does not support yet` afterwards. A view of a
  record that also holds functions calls them with `this` = a snapshot.
  On the native lanes the Proxy is real: `unshift` and `splice` on an
  array view run over a copy written back (so their own function
  identities differ from `Array.prototype`'s), every other access goes
  through the traps live. A cyclic typed structure seen through views
  prints with the native fence (`util.inspect of a composite ...`) and
  overflows on wasm, where Node prints `[Circular *1]`. On wasm an error
  caught from dynamic code answers `e.constructor.name` (the error's own
  name); calling that constructor is a named Error.
- **(d) EXITS: a dynamic value enters typed storage only when it is
  FRESH or its own VIEW; every other exit refuses at compile time,
  SC1090, the same text on every lane** (Joe's ruling, 2026-10-27:
  STRICT). Typed storage
  cannot hold an engine value, so an exit is a copy; it is allowed
  exactly where the copy cannot be told from the original. FRESHNESS is
  proven from the source expression by PROVENANCE, never by spelling: a
  call counts only when its resolved symbol is the standard library's
  own (every declaration in the lib — a user function merging with a
  global's name, a local `JSON` or a user class named `Response` never
  count), a method only on a receiver whose static type is the builtin
  Array (or a string) — never `any`, never a user subclass — and a user
  function only when it is a function declaration or a `const` binding
  of a function literal (methods are overridable, `let`s reassignable),
  non-async, non-generator, every return fresh. The fresh forms:
  `JSON.parse(text)`, `structuredClone(...)` (of a dynamic value the
  engine's own clone on the native lanes), `await response.json()`
  (the lib's Response/Request), array and object literals whose members
  are primitives or themselves fresh — `[...x]` and `{ ...x }` of a
  dynamic `x` included (the idiomatic copy-out: element/field-checked,
  when the elements/fields are not typed composites) — `Object.keys`,
  `Object.assign({}, ...)`, `Array.from` / `Object.values` /
  `Object.entries` (on the native lanes `Array.from(x)` of a dynamic `x`
  is the engine's own; the wasm lane refuses it by name — spell it
  `[...x]`), the builtin array-building methods (`map`, `filter`,
  `slice`, `concat`, `flat`, `flatMap`, `toSorted`, `toReversed`,
  `toSpliced`, `with`) and the in-place `sort`/`reverse`/`fill`/
  `copyWithin` of a fresh receiver when the elements are primitives (a
  `map` whose literal callback returns fresh values too), string `split`
  / `match`, fresh-returning user functions as above, and conditionals /
  `??` / `||` over fresh branches. A copy CONSUMED on the spot counts
  too: the seed of `new Set(x)` / `new Map(x)`, the source of
  `Array.from(x)`, the subject of `for (... of x)` (primitive elements).
  A VIEW returning to its own static type UNWRAPS — no copy, identity
  kept — where the compiler can see it is one: inside a view's own write
  (b), from a `const` binding typed `any`/`unknown` initialized from a
  non-literal value of exactly that static type (`const d: any = point;
  d as P`), and from a member of the program's own compiled module (a
  dynamic `import()` namespace's member); the unwrap still checks at run
  time. A typed callback PARAMETER that dynamic or package code passes
  a value into, and a PACKAGE-declared typed result bound into a typed
  slot, are exits like any other: each would copy the package's object,
  which the package could change while the copy is read (across a call
  or an `await`), and which can carry keys the type does not declare
  (visible to printing, `JSON.stringify`, key order, `toString`) —
  refused; type them `any` (sharing the real object) or copy explicitly
  with `[...x]` / `{ ...x }`. The copies that remain are checked copies
  of FRESH values, built where nothing else holds them: their content is
  the value's own; a RECORD copy (`{ ...x }`, `Object.assign({}, x)`,
  `JSON.parse` into a record type) keeps the record type's declared
  fields in declaration order — keys the type does not declare are
  dropped and key order is the type's (S009's width-tolerant
  conversion), and a value that does not fit throws the checked
  conversion's `expected <T> at <path>, got <kind>` TypeError where Node
  runs on (the TypeScript lie); array copies (`[...x]`) keep every
  element in order and are exact. A `for (... of x)` subject counts as
  consumed only over primitive elements — composite elements are shared
  in Node, so that exit refuses. Anything else refuses with
  `an 'any' value flowing into a typed 'T' slot: typed storage cannot
  hold an island value, so this would be a COPY, and the compiler cannot
  see that nothing else holds the value (SEMANTICS.md S115) — keep the
  slot 'any'/'any[]' so both sides share one value, or copy explicitly
  where the copy is meant: [...x] or { ...x } (JSON.parse(JSON.stringify(x))
  for nested data)` (`an 'unknown' value` from `unknown`); a typed
  callback parameter refuses with `a function called from dynamic code
  with a typed 'T' parameter 'x': each call would COPY the dynamic
  argument into typed storage, ... — type the parameter 'any' so it
  shares the caller's value, or copy explicitly inside the function with
  [...x] / { ...x }`.

**Tested by:** `packages/compiler/test/wasm-any-array-shared.test.ts` —
H-VIEW-01..09 ((a), wasm and c against Node), H-VERR-01..08 ((b), wasm and
c), H-VWASM-01 ((c), every lane against Node), H-EXIT-01..20 ((d)
refusals, wasm and c identical; H-EXIT-20 the callback parameter,
H-EXIT-20c the explicit copy), H-FRESH-01..03 and
H-UNVIEW-01 ((d) fresh exits and unwraps), H-UNK-01 (`unknown`),
H-HOST-01 (host results), `wasm-view-scaling.test.ts` H-SCALE-01
(linear view mutation on wasm), H-CORPUS-2787
and H-CORPUS-2788; corpus `2787-any-array-shared.ts`,
`2788-typed-views.ts`, `762-any-boundary.ts` (the unwrap),
`766-any-union-boundary.ts` (union fields) and
`2050-dynamic-import-own-module` (a namespace member's unwrap) on every
lane; `tests/harness/npm.test.ts` ("a typed record callback parameter is
refused at compile time, by name");
`tests/harness/island.test.ts` ("a typed record crossing into an 'any'
binding is a live view"). Measured against Node v24.18.1.

## S117 — The wasm-native lane runs the wasm module natively; it parts from Node where the native lanes do (argv, execPath, versions, a real clock), in its stack depth, its heap limit and the text of a trap, and where its own host answers for the event sources (its TLS engine and trust store, its fetch client) *(wasm-native lane)*

The wasm-native lane (`backend: "wasm-native"`, native-runner phase N0) is
the wasm lane's own module translated to C (`backend/wasm2c.ts`, the
whole-program profile) and linked with the native runner
(`packages/runtime/src/wasmnative`: the collector `wn_gc.c`, the C host for
abi.ts's imports — `wn_host.c` for the process, clocks, files and zones and,
since phase N1, the event sources: `wn_ev.c` (the event queue and the
loop's wait, signals, fs.watch, stdin), `wn_cp.c` (child processes),
`wn_net.c` (TCP, UDP, lookups), `wn_tls.c` (the TLS engine) and
`wn_fetch.c` (fetch) — and the driver `wn_main.c`). Every behavior is the
module's, so everything the wasm lane registers applies unchanged except
where a clause below says the wasm lane's differential HOST decided it;
this entry lists what the runner itself decides:

(a) **Process facts are a native process's**: `process.argv` is
`["scriptc", <the invocation>, ...]` and `process.execPath` the
executable's resolved path, as on the c and llvm lanes (S070, S071);
`process.versions.node`/`.openssl` are the S072 constants. The clock is
real (`now`, `wallClock`, timers wait with nanosleep), as on the native
lanes — the wasm lane's differential host runs a virtual clock instead.
Local time is the C library's, so S113's (a) (zone data) and (b) (the
zone names table) apply to this lane exactly as to the c and llvm lanes.
A signal the process sends itself (`process.kill(process.pid, "SIGSEGV")`)
ends it as it ends Node, killed by that signal.

(b) **Stack depth.** The depth limit is a count of wasm frames, the same
on every machine and C compiler (native-runner N2a): every translated
function that calls another counts its frame (`w_depth`, wasm2c.ts
translateBody; a leaf adds at most one frame and is not counted), and past
`W_DEPTH_MAX` = 20,000 frames the program ends with `RangeError: Maximum
call stack size exceeded` on stderr and exit status 1, uncatchable — the
wasm lane's own outcome for a stack overflow (V8's RangeError ends the run;
the module has no way to catch one). The limit sits above both measured
depths (Node v24.18.1, default stack): the wasm lane reaches about 17,900
frames of a no-argument recursion and 11,400–13,900 of a closure, a
method, a mutual and a one-argument recursion; Node reaches 9,600–12,500
on the same shapes, each of which is one wasm frame per call here, so on
those shapes a recursion Node survives survives here (N2A-STACK-01 holds
9,000). It is not a guarantee for every program: where one JS call is
several counted wasm frames (a call through module helpers that
themselves call), the count grows faster than Node's stack and such a
recursion can overflow here at a depth Node survives. Where Node
diverges: (1) Node's `RangeError` is CATCHABLE — `try { recurse() } catch
(e) {}` recovers under Node and ends the run here, as on the wasm lane;
(2) the depth differs — a one-frame-per-call recursion between Node's
limit and 20,000 frames completes here where Node throws, and a recursion
of several wasm frames per call overflows sooner, as just said. A tail-position recursion counts too (the count
keeps the C compiler from turning it into a loop that never ends). The
program runs on a 512 MiB stack, so the count, not the stack, is what
overflows; a frame larger than the 64 KiB guard cannot step over it (the
translation is compiled with `-fstack-clash-protection`), and a guard-page
fault reports the same RangeError text.

(c) **Heap limit.** The collector's arena is 64 GiB of address space; a
program whose live heap passes V8's limit (Node aborts with a fatal
out-of-memory error) keeps running here.

(d) **Trap text.** Every trap prints V8's own RuntimeError text for it —
the module's own `unreachable` included (`RuntimeError: unreachable`, after
the uncaught-error report the module has already printed on that path —
S007, S010), and the others (`divide by zero`,
`divide result unrepresentable`, `remainder by zero`, `float
unrepresentable in integer range`, `memory access out of bounds`, `data
segment out of bounds`, `requested new array is too large` past V8's own
array limits, `null function or function signature mismatch`, …) to
stderr before exit status 1, where it happens in the program — every
memory access is bounds-checked where wasm makes it, never left to a fault
the C compiler may move or delete. Nonzero-exit stderr is not Node's on
the wasm lane either (S007). A fault the runner cannot attribute to the
program (a runner bug) says so and exits 70, never 1.

(e) **NaN bits.** Every float operation runs as the instruction it is —
the translation is compiled with `-ffp-model=strict`, so `x * -1`,
`x / 1`, `x - 0`, `-0 - x` and their kin keep a NaN operand's bits as V8
does (JS-observable through a Float64Array or Buffer), never folded into a
sign flip or the operand. `min`/`max` with a NaN operand answer V8's NaN
on x86-64 (the processor's default NaN, whatever the operands); on other
architectures the NaN operand propagates, quieted (V8 there unmeasured).
The one residue: when BOTH operands of a commutative operation are NaNs,
which payload survives is the instruction's operand order, which the C
compiler chooses — and so does V8's (the instruction set keeps the first
operand's); measured on constants, V8 kept the first and this lane the
second.

(f) **Every import of abi.ts is the runner's own host's.** None refuses at
build time any more (phase N0 refused the event sources by name,
`host:<import>`). The host is libuv's level transcribed onto epoll, on the
real clock: the module's `_loop` is called again once an event is queued or
its deadline is reached (an epoll wait — never a spin; a wait no source can
end is the runner's loud error, exit 70); one epoll round is one host
iteration, so its net events form one poll phase (abi.ts evPoll); a
descriptor's new interest reaches epoll at the next wait, in the order it
was asked for (libuv's watcher queue — so a client's connect is reported
after the server's accept of it, as under Node); a read that does not fill
its 64 KiB buffer ends that descriptor's turn (uv__read: an end of file
read behind it is the next iteration's); a signal and a child's exit are
handled after the round's other descriptors (libuv runs its signal watcher
last), and every exited child is reaped then, in spawn order, before any
exit is queued (uv__wait_children: inside one child's `'exit'` a sibling of
the same batch is already reaped). Lookups run getaddrinfo on a thread, as
libuv's do. Where the wasm lane's differential host (Node itself, in
process) decided an answer, this host decides it as a separate native
process does — and so, for S086, as Node does:
- a child's inherited stream, or the program's fd 1 or 2 in a stdio slot,
  is passed to the child as the real descriptor (abi.ts allows it when the
  host's descriptors are the program's own), so S086 (a), (b), (c), (f)
  and (g) do not apply: output lands where Node's child's does, unlimited
  and in real time; an `"inherit"` stdin is the real fd 0 (S086 (h) does not
  apply, nor (d)'s `"inherit"` half); a numbered descriptor is the
  process's own, passed as libuv passes it (S086 (j) does not apply); and
  children still running when the program ends are left running, as Node
  leaves them (S086 (i) does not apply). S086 (d)'s `"ignore"` half (the
  lowering's), (e), (k) and (l) apply. In short: **S086 (a)–(c) and
  (f)–(j) do not apply to this lane** (a deliberate choice: the real
  descriptors are the more Node-exact host). A child's pipes are
  socketpairs, as libuv's are.
- the runner starts in well under a millisecond and reaches its first poll
  phase long before Node's module loader settles: a child's first output
  that Node sees in its first poll phase can arrive after this lane's
  (U3-ORD-01, measured).

(g) **TLS is Node's own OpenSSL, driven as Node's C++ drives it**
(OpenSSL units O2, O3). The host links the OpenSSL Node v24.18.1 bundles
(3.5.7, `packages/runtime/vendor/openssl`, built by
`backend/openssl-build.ts` with Node's defines, its error records naming
files as Node's do — `../deps/openssl/openssl/...` — and, for Linux,
`__LINE__` as gcc, Node's Linux compiler, reads a macro call that spans
lines) and nothing else. It starts OpenSSL as Node starts it (`wn_trust.c`,
from `src/node.cc` and `crypto_util.cc`: `OPENSSL_CONF`, or
`--openssl-config` in `NODE_OPTIONS`, read for its `nodejs_conf` section —
`openssl_conf` under `--openssl-shared-config` — missing files ignored;
`--openssl-legacy-provider` loads the legacy provider), but at the
program's first TLS context or https fetch rather than at process start: a
configuration error ends the process there, with Node's text
("<argv[0]>: OpenSSL configuration error:" and OpenSSL's error lines) under
the executable's own name and Node's exit status (the error's reason), and
a program that uses no TLS never reads the configuration (Node refuses to
start). The other TLS options Node takes from `NODE_OPTIONS` are applied
as Node applies them: `--tls-min-v1.0` / `-v1.1` / `-v1.2` / `-v1.3` and
`--tls-max-v1.2` / `-v1.3` set the protocol bounds every context starts
with (lib/tls.js's precedence), `--tls-cipher-list` the default cipher list
(split by `processCiphers`; no TLS 1.2 cipher makes TLS 1.3 the minimum),
`--tls-keylog` appends each TLS socket's key lines to its file (mode 0600)
after Node's warning, `--use-openssl-ca` / `--use-bundled-ca` /
`--use-system-ca` pick the stores; Node's start-up refusals of these —
`--tls-min-v1.3` with `--tls-max-v1.2`, a `--tls-cipher-list=` or
`--tls-keylog=` without a value (exit 9), `--enable-fips` / `--force-fips`
with no FIPS provider, which Node's bundled OpenSSL lacks ("OpenSSL error
when trying to enable FIPS:", exit 1) — happen at the first TLS use, as
the configuration's do. A default cipher list Node's `createSecureContext`
throws over (OpenSSL refuses it, or it names no cipher) fails a fetch with
Node's error, and is a named refusal for a node:tls context (the module's
CTX_NEW has no failure answer; Node throws it to the program). Node's
keylog warning prints its `--trace-warnings` hint itself, so a program
that also emits a warning sees the hint twice. Node's tls.DEFAULT_MIN_VERSION,
DEFAULT_MAX_VERSION and DEFAULT_CIPHERS, which a program can read, stay
the module's defaults. The host reads `NODE_OPTIONS`, `NODE_USE_SYSTEM_CA`,
`NODE_EXTRA_CA_CERTS`, `OPENSSL_CONF`, `SSL_CERT_FILE` and `SSL_CERT_DIR`
as Node's `credentials::SafeGetenv` does — unset in a process running with
elevated rights (AT_SECURE, or a real uid/gid other than the effective
one); the proxy variables fetch reads are JavaScript's `process.env` under
Node, plain. Each context is a Node SecureContext (`crypto_context.cc`): an
SSL_CTX made as `SecureContext::Init` makes one (those protocol bounds,
Node's options, modes, session-cache mode and ticket-key callback) with
`configSecureContext`'s defaults (that cipher list;
`ecdhCurve` `auto`, so OpenSSL's groups, X25519MLKEM768 first); a `cert`
is Node's `SSL_CTX_use_certificate_chain` and a `key`
`PEM_read_bio_PrivateKey` + `SSL_CTX_use_PrivateKey`, their failures
OpenSSL's own error with Node's code (`ERR_OSSL_PEM_NO_START_LINE`,
`ERR_OSSL_X509_KEY_VALUES_MISMATCH`, ...). The trust is Node's: CTX_ROOTS
shares the one root store `NewRootCertStore` builds — Node's bundled
roots, the very bytes the module carries for `tls.rootCertificates`
(`backend/wasm/tls-roots.ts`, compiled into the runner from that module),
then the system store with `--use-system-ca` (`NODE_OPTIONS`) or
`NODE_USE_SYSTEM_CA=1`, then `NODE_EXTRA_CA_CERTS`'s certificates;
`--use-openssl-ca` puts OpenSSL's default locations in place of the bundled
and system sets; no `X509_V_FLAG_*` is set — and a `ca` adds to the
context's own copy (`SetCACert`, `GetCertStoreOwnedByThisSecureContext`).
`getCACertificates("system")` is what Node's Linux loader reads:
`SSL_CERT_FILE`, else OpenSSL's default file `/etc/ssl/cert.pem`, then
every regular file of `SSL_CERT_DIR`, else `/etc/ssl/certs`, in name order
(a directory that cannot be opened prints Node's "Cannot open directory
... to load OpenSSL certificates."); `"extra"` is `NODE_EXTRA_CA_CERTS`'s
file, and one that cannot be read prints Node's "Warning: Ignoring extra
certs from `<file>`, load failed: <OpenSSL's error>" when the host first
loads it (Node loads it on a thread when node:tls loads, its timing against
the program's output a race). A secured socket is Node's TLSWrap
(`crypto_tls.cc`): an SSL over two memory BIOs fed from the socket's reads
(libuv's) and drained into its writes, the always-accepting verify
callback, SNI from the module's servername, the handshake's completion
reported from OpenSSL's handshake-done callback with
`SSL_get_verify_result` — Node's verdict, code for code, by construction —
and the peer's certificate; a TLS failure is TLSWrap's error: the message
`ERR_print_errors` gives (OpenSSL's last error line, which opens with the
thread's id — the process's own value, as Node's is its own) and the code
`ERR_SSL_` + its reason. A server acknowledges no SNI (no SNICallback is
offered). What is not Node's: the module still drives events and
`checkServerIdentity` (S090), and no session is resumed (S090 (f)).

(h) **fetch is the runner's own HTTP/1.1 client** (`wn_fetch.c`), made to
answer as Node's undici does (measured against Node v24.18.1; S098 (a)
names these the host's answers): the Request constructor's refusals and
their texts, the request head (`host`, `connection`, the program's headers
in its order with same names combined, `content-type`, then undici's
defaults, then `content-length`), the fetch spec's bad ports, redirects (20
hops, the 303 and POST rewrites, credentials dropped across origins,
"unexpected redirect", "redirect count exceeded", "URL scheme must be a
HTTP(S) scheme"), `data:` URLs, the other schemes' failures, gzip / x-gzip
/ deflate decoding, `NODE_USE_ENV_PROXY` with `http_proxy` and `no_proxy`,
and the failures ("fetch failed" over `connect ECONNREFUSED <ip>:<port>`,
`getaddrinfo ENOTFOUND <host>`, undici's "other side closed", "terminated"
for a body cut short, an AggregateError for a name whose every address
refused). These differ from Node: no connection is kept for reuse (undici's
pool shows only to the server); `br` and `zstd` bodies are delivered as
they came (undici decodes them); a host name holding a non-ASCII character
is "Invalid URL" (no IDNA); a proxied `http:` request is an absolute-URI
request (undici tunnels it with CONNECT; `https:` is tunnelled here too);
undici's process warnings (a lowercase `patch`) are not printed; there are
no connect, headers or body timeouts (undici's are 10 s, 300 s and 300 s:
a server that stalls holds the request until the program aborts it); TLS
verification is (g)'s, as undici's tls.connect reaches it (a default
secure context over (g)'s root store, SNI for a host name, ALPN
`http/1.1`; a TLS failure before the handshake ends is the socket's
error, Node's message and code; one after it is EMITTED on the socket and
the socket stays open, as `_tls_wrap.js` does — undici keeps it as the
socket's error and the request fails with it when the socket closes,
unless what follows replaces it first (a reset's `read ECONNRESET`, the
peer's end — undici's "other side closed" or a finished response —, a
parser error such as the content-length mismatch), so against a peer that
corrupts records, sends an alert mid-body or demands a client certificate
after a TLS 1.3 handshake fetch fails exactly as Node's does;
no TLS session is kept for resumption — undici's session cache shows only
to the server), with
Node's code and reason (its `--use-system-ca` suggestion included), and
the host name is checked as Node's `tls.checkServerIdentity` checks it,
over the certificate as Node hands it to that function: its
`subjectaltname` as ncrypto prints OpenSSL's parse of it (Node's escaping
of an unsafe name — a NUL, a comma, a DEL — included, a directoryName as
`X509_NAME_print_ex` prints it, and names compared with their lengths, so
a NUL never ends one), its subject's CNs (any of several may match); an
IP literal against the IP-address names, a DNS name against the DNS names
with RFC 6125 wildcards, or the CN when there are none; an IPv6 host (the
URL's, without brackets) never matches, as under Node. A response is read by undici's own parser: the llhttp wasm
module Node's undici instantiates (`backend/wasm/undici-llhttp.ts`,
translated by wasm2c), driven by a transcription of undici's client-h1
Parser callbacks, so a response is accepted, or refused with its reason,
as Node's fetch accepts or refuses it (undici's errors: "Response does not
match the HTTP/1.1 protocol (...)", the content-length mismatch, "Headers
Overflow Error", "bad response" for a 100, "bad upgrade", "other side
closed"); the status text is the last piece of the status line a read
delivered, as undici keeps it. The proxy's answer to a CONNECT is read by
the same parser; an answer other than 200, or a proxy that closes before
answering, fails the request (undici's "Proxy response (407) !== 200 when
HTTP Tunneling", "other side closed") where Node's undici retries the
CONNECT without end. A redirect to a URL with credentials is undici's
'cross origin not allowed for request mode "cors"', and a program's own
Proxy-Authorization header on a proxied request is undici's
InvalidArgumentError. An `xn--` label must decode as Punycode to something
that is not plain ASCII and holds no control, ASCII capital or symbol,
surrogate or noncharacter, else "Invalid URL"; UTS #46's mapping table is
not consulted, so a label decoding to a code point UTS #46 maps or
disallows (`xn--a-ecp`, "a⒈") is accepted here where Node's URL refuses
it.

(i) **The translator trusts a valid module.** `wasm2c` assumes the
module's types and stack discipline hold; the lane validates every module
with the engine's own `WebAssembly.validate` before translating, and an
invalid one refuses (`wasm2c:the module does not validate`).

**Tested by:** `tests/harness/wasmnative-differential.test.ts` (the whole
corpus against Node; `SCRIPTC_WASMNATIVE_GC_STRESS=n` runs it with the
collector forced every n allocations);
`tests/harness/wasmnative-host-rows.test.ts` (N2A-STACK-01 and -02 hold
(b): a recursion Node survives answers as Node, and an unbounded one — a
tail call included — ends with the RangeError text and exit 1, and
`packages/compiler/test/wasm2c-whole.test.ts`'s stack-depth test holds the
count itself: 20,000 frames run, the next traps, a leaf is not counted;
N2A-TLS-01 and -02 hold the TLS host's write pattern against Node — one
write per TLSWrap cycle, a gated write completed before the program's
setImmediate and timers, S090 (h)'s wasm-native note;
every program of the wasm
lane's host rows — child_process, node:net / http / tls / https / dgram,
signals, fs.watch, stdin and readline — and the fetch fixtures, natively,
against Node: (f)'s second item is its `UNPINNED` U3-ORD-01; its `KNOWN`
list names the module's own divergences, which this lane shares; its
security re-review rows hold (g)'s verdicts and (h)'s name check over the
certificates `tests/fixtures/tls-review/gen.py` makes, through a CONNECT
proxy, and (h)'s parser over `tests/fixtures/tls-review/responses.mjs`'s
malformed responses and its fuzz of them; the proxy's refusal row holds
the lane alone, Node retrying; its board #332 rows hold (g) over the
malformed certificates `tests/fixtures/tls-review/gen-malformed.py` makes,
served by `esrv.c` on mbedTLS, through fetch and tls.connect, every
verdict and handshake failure — message and code — Node's; its O23 rows hold (g)'s NODE_OPTIONS TLS options and (h)'s error mapping against `tests/fixtures/tls-review/hostile.py`'s peers);
`packages/compiler/test/openssl-vendor.test.ts` (the vendored OpenSSL is
Node's, and joining a multi-line macro call keeps every line's number);
`tests/harness/event-loop.test.ts`, `console-io.test.ts` and
`dgram.test.ts` (each case on the c and wasm-native lanes); and
`packages/compiler/test/wasm2c-whole.test.ts` (the translation against
Node's own WebAssembly: every numeric operator and conversion bit for bit,
linear memory to its end, the GC instructions under a stressed
collector, NaN operands of the folded identities, every trap's text
through the real runner), and `packages/compiler/test/wasm-native.test.ts`
(the host end to end: paths holding U+0000, copyFileSync onto itself, a
self-sent SIGSEGV, the descriptor audits, and that the vendored llhttp is
the running Node's undici's). (b) was measured by hand (`f(50000)`, then unbounded
recursion: the native trap in 0.2 s, exit 1).

## S118 — The WasmGC tier compiles one module for every OS: it learns its OS from the host at run time, and where its own Node behaviour for an OS is not built yet it stops there by name *(wasm and wasm-native lanes)*

**Stance.** Node's observable behaviour differs by OS — `process.platform`,
signal and errno numbers (`os.constants.signals`, `util.getSystemErrorMap()`),
the bare `path` module (path.win32 on Windows), `path.sep` / `path.delimiter`
/ `os.EOL`, `stream.getDefaultHighWaterMark(false)` (16 KiB on win32, 64 KiB
elsewhere). The WasmGC tier bakes none of these into the module: the frontend
lowers a wasm build as a `"host"` platform build, and the module asks the host
(abi.ts: `hostStr` kind 4 for the platform's name, `hostNum` kinds 16 and 17
for the number the host's OS gives a signal / errno NAME — the module keeps
only names, `backend/wasm/os-names.ts`, generated from Node's libuv headers by
`scripts/gen-os-names.mjs` — and kind 18 for the platform as a number). Every
signal or errno number crossing the host contract is the host OS's own; the
module names it through those kinds. The JS host answers from the Node it runs
under (`os.constants.signals`, `util.getSystemErrorMap()`), the native hosts
from `wn_os_names.h` (libuv's own `uv/errno.h`, vendored beside it). On Linux
every answer is the value the module used to bake in, so Linux output is
unchanged.

**What still parts from Node off Linux, by name.**
- (a) `url.fileURLToPath` and the bare module's `url.pathToFileURL` on win32:
  Node's win32 arms (drive letters, backslashes, UNC) are not in the tier; the
  program stops with `wasm tier: url.… is not supported on win32 yet`.
- (b) Not yet guarded, and reached by no lane today (the wasm-native runner
  refuses a macOS or Windows target by name, `wasm-native:target`, and no
  harness runs the wasm lane under Node off Linux): `process.env`'s
  case-insensitive keys on win32, `execSync`'s shell (`/bin/sh -c`; Node on
  win32 uses `cmd.exe /d /s /c`), `process.getuid`/`getgid` (absent on win32),
  `fs.lchmod` (a real function on macOS; the tier builds Linux's "is not a
  function" arm), and the dns `ADDRCONFIG` flag's spelling in the native host
  (`wn_net.c` passes the contract's bit 32 to getaddrinfo raw — Linux's
  value; the JS host maps it to its Node's `dns.ADDRCONFIG`). Each must be
  made loud or exact before a macOS or Windows host ships.
- (c) `process.on('SIGINT' | 'SIGTERM')` still lowers the numbers 2 and 15:
  they are those signals' numbers on every OS Node runs on (libuv's Windows
  emulation included).

**Tested by:** the wasm and wasm-native differentials (Linux: unchanged
output); `packages/compiler/test/os-names.test.ts` (the names are Node's: the
signal list covers this Node's `os.constants.signals` in its order, the errno
list is `util.getSystemErrorMap()`'s names and texts, and `wn_os_names.h`'s
tables are generated from the same lists); `packages/compiler/test/wasm-native.test.ts`'s
cross-target row (an aarch64-linux build carries the host build's module byte
for byte; macOS and Windows targets refuse by name).
