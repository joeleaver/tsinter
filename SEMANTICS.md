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
inside the vector — and a boxed function carries no property table at
all. Six observable consequences follow — four loud, and two that say
nothing at all. What is exact first, so the boundary is
clear: object writes (insertion order, later writes winning, the
surviving entry keeping its original key), array index writes within the
allocatable range (`length` and every read match Node), and the refusals
on nullish, number and boolean receivers, which are V8's own texts
character for character.

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

**A write on a boxed FUNCTION throws where Node stores it.** Functions
are objects in JS, so `f.x = 1` succeeds there and reads back; here it
raises the same catchable "Cannot create property 'x' on function" the
primitive receivers get. A boxed function's payload carries the closure,
its call thunk, its signature, its name and its arity — and no property
table: the one the C runtime hangs off the closure is written only by
`Object.defineProperties`, which this backend refuses, so there is
nothing a write could land in. The PRESENCE forms over the two members
Node does define are exact — `"name" in f` and `Object.hasOwn(f, "name")`
are both true, as in Node — so this arm is about the write alone; what
those two members ANSWER when read is S020's, not this entry's.

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

CYCLES are where the two walkers part company. The STATIC path detects
them exactly: a cyclic value of a recursive record type throws V8's
`TypeError: Converting circular structure to JSON` with the message built
byte for byte, so the cap is not what reports it. The DYN walker has no
cycle detector, so a cyclic dyn tree — constructible through dyn keyed
writes, `const o: any = {}; o.self = o` — runs out of depth instead and
reports the RangeError above: right that it failed, wrong about why. That
gap closes when the dyn tree grows its own seen stack.

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
an explicit value stack in both walkers, plus a seen stack for the dyn
tree so its cycles report the TypeError instead.
**Tested by:** the wasm emitter unit tests, on both paths — 1000 nested
objects serialize and 1001 throws through the dyn walker; a 1000-deep
acyclic value of a recursive record type serializes and 1001 throws
through the static one; a cyclic dyn tree throws; and the buffer, seen
stack and depth counter all recover for the next call. No corpus program
can pin it: the native lanes diverge from this by construction (C caps
neither path).
