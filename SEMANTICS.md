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

## S015 — Keyed reads and `in` on `unknown` see OWN properties only *(inherited)*

`u[k]` on a checked-dynamic value answers the receiver's OWN member, or
`undefined` when it has none. Node consults the prototype chain, so
`JSON.parse('{}')["toString"]` is a real function there and `undefined`
here; the same holds for every inherited member of Object, Array and
String (`hasOwnProperty`, `valueOf`, `slice` as a VALUE rather than a
call, ...). The PRESENCE operator answers the same way for the same
reason — `"toString" in u` is `true` in Node and `false` here, as is
`"slice" in u` on a dyn array — because there is no chain to walk, only
the own-entry table the read consults. (`Object.hasOwn` is own-only by
definition, so it agrees with Node wherever the member genuinely exists,
string receivers included; it parts company only where S016's padding
invents members Node left as holes.) The named forms that DO work are
the ones the runtime models directly: `length` on arrays and strings,
canonical index reads, and prototype METHOD CALLS, which dispatch on the
receiver's kind rather than reading a member (S023's surface). **Rationale:** inherited
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
from its own AST, so the two part company in four places. `(g)(1)` says
"g is not a function" in Node and "value is not a function" here (any
parenthesized callee); `o . a . b (1)` says "o.a.b" there and
"o . a . b" here (raw source keeps the spaces); `o["f"]()` says "o.f"
there — V8 re-renders a string-literal computed key as a dotted one —
and `o["f"]` here; and a callee with no referenceable spelling at all,
such as `(c ? g : g)(1)`,
says "(intermediate value)(intermediate value)(intermediate value)"
there and "value" here. The shapes that AGREE are the common ones: a
bare identifier, a dotted chain, a computed access with a variable key
(`o[k]`), and an element index (`o.arr[0]`). Argument EVALUATION order
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

**Struck: Math-function NaN provenance.** `Math.sqrt`, `Math.log`,
`Math.pow`, and every other `Math.*` call all REFUSE on this tier today
(`SC2012` — dyn-engine-only, `milestone: M4`) — there is no in-tier
arithmetic path that can produce a NaN outside plain `+ - * / % **`.
Verified directly this round (`Math.sqrt(-1)`/`Math.log(-1)`/
`Math.pow(-1,0.5)` all refuse). The reviewer's third NaN-payload pattern
(`Math.log(-1)` → `7ff4000000000000`, neither canonical nor hardware —
libm's own payload choice) is registered here as a KNOWN FUTURE AXIS,
not measured against this tier, because nothing compiles today that
could diverge on it. Revisit when any `Math.*` call lands in-tier.

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
- **`Math.pow` / `**` beyond the exact set**: the ECMA-262 special-value
  table (NaN, ±0, ±Infinity, base ±1, negative-base-non-integer)
  computes exactly, and `y === 2` computes as `x*x` — the one form
  fdlibm (V8's pow) itself special-cases to an elementary op, so
  bit-exactness is by construction, and the only measured corpus need.
  EVERY other exponent — other integers included — throws the catchable
  "Math.pow with this exponent is not supported yet": fdlibm's
  polynomial path is not reproducible by exponentiation-by-squaring at
  last-ulp fidelity, and an unprovable answer is the miscompile class,
  not a feature.
- **`Number.prototype.toString(radix)` with radix ≠ 10** throws the
  catchable "'Number.prototype.toString' with a radix other than 10 is
  not supported yet" — V8's DoubleToRadixCString is unported; silently
  answering base-10 digits under a false base claim was the alternative
  this fence replaces.
- **`Number.prototype.toFixed` beyond the verified window**: requests
  whose significant-digit demand exceeds the conservatively-verified
  bound (effective `intDigits + f <= 14`) throw the catchable
  "'Number.prototype.toFixed' at this precision is not supported yet";
  in-window results are byte-exact (120-cell independent differential:
  56 exact, 64 fenced, 0 wrong). The designed trade, named so it is not
  a surprise: the fence fires on ordinary-looking calls Node computes
  fine — `(999999999999999).toFixed(0)`,
  `(1234567890.12345).toFixed(5)` — fence-over-garbage, the pow
  precedent.
- **The unmodeled-name half of the Number-placeholder call surface**:
  calling an extracted placeholder whose NAME is not modeled for real
  dispatch (`toPrecision.call(5, 3)`, which Node computes) throws the
  honest "'Number.prototype.toPrecision' on a dynamic value is not
  supported yet" — while the WRONG-RECEIVER case keeps Node's own exact
  "requires that 'this' be a Number" TypeError (the split replaced one
  false message covering both situations).

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
  threshold prints nothing at all. When it lands, it inherits the
  synchronous-print stance below rather than inventing a third timing.

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

## S060 — `url.fileURLToPathStr`'s file-scheme parser is narrower than Node's WHATWG parser on three axes: dot-segment resolution, percent-DECODED non-ASCII path bytes, and malformed percent-escapes — each traps by NAME rather than a silent wrong answer *(wasm tier)*

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
