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
`err.name`, `err.code` and `instanceof` are all exact.

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
implementation plus current EAW data, best done once, shared with the case
tables `toLowerCase`/`toUpperCase` are also waiting on.

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
which is frontend surgery out of scope for this fix round (see the
board's #22 disposition). **Measured against the differential harness's
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
   `numLit`); tracked for a future increment.
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
