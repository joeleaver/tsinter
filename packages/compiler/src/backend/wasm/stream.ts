/* node:stream's Readable over WasmGC — scr_stream.c's readable-side state
 * machine ported (PASS 1: construction, push/read, pause/resume/flow with
 * the direct-emit fast path, destroy's default path, the underscore _read
 * dispatch, and the scalar/flowing/errored property surface). Mirrors
 * events.ts's shape exactly: one shared struct family for every
 * %Readable-rooted class (root AND every user subclass — classes.ts's
 * gate lift), hand-built functions over an explicit Code buffer, PURE
 * RUNTIME STRUCTURE — this file never touches an IrType.
 *
 * SCHEDULING. Every deferred stream callback ('readable' collapse,
 * 'resume', 'end', 'error', 'close', `maybeReadMore_`'s own tick (R3),
 * and the 'readable'-listener-added priming `read(0)` (`nReadingNextTick`,
 * 2572's fix)) is a NODE on this file's OWN private FIFO (`$rTick`),
 * dispatched one-at-a-time through nexttick.ts's
 * raw-marker seam (`enqueueRaw`/`rawFnType` — built in stage 0 for exactly
 * this): scheduling a stream tick both appends to THIS file's list AND
 * posts one bare marker onto the user process.nextTick queue, so stream
 * ticks and user nextTicks interleave in true enqueue-order FIFO (2627's
 * pin) without this file needing to touch nexttick.ts's queue struct
 * directly — the scr_st_tick / scr_stream_dispatch_one split, ported.
 *
 * THE EMITDATA ABI DECISION (unpinned by the frontend — lower-stream.ts's
 * IR-level 'data' tuple is always a single `bytes` value; nothing forces
 * a two-slot shape at the wasm boundary). This file boxes the delivered
 * chunk through dyn.ts's ordinary `boxBytes`/the general emitter dispatch
 * (events.ts's `emitDispatch`, the SAME path any user-defined event uses)
 * rather than inventing a dedicated stream-only listener ABI: a listener
 * declared `(chunk: Buffer) => void` already lowers, at the emitter
 * layer, to a thunk that unboxes dyn arg 0 back to bytes (the general
 * family's existing per-signature thunk machinery, events.ts's own
 * header) — so 'data' degenerates into the dyn-tuple path with ZERO new
 * machinery, exactly the design doc's bet at §1. Rejected alternative: a
 * bytes-specific fast lane bypassing the dyn array entirely (skip the
 * box/unbox round trip) — buys nothing measurable (the dyn box is one
 * struct.new over a value already computed) and would need a SECOND
 * thunk-adaptation story beside the one events.ts already owns; not worth
 * the duplication for a single event name.
 *
 * SCOPE. Pass 1 (see the stage-B checkpoint messages for the
 * contamination ruling that scope reflected): readable.new/init (STATIC
 * literal-options form only), push/pushStr/pushNull/unshift/unshiftStr
 * (unshift/unshiftStr reclassified INTO pass 1 during its landing,
 * trivial once push's `front` parameter existed and 1686 needed it),
 * read, pause/resume/isPaused, the flow state machine + direct-emit fast
 * path + `maybeReadMore` (R3, ported in the gate round), 'data'/
 * 'readable'/'end'/'close' through events.ts's EXISTING general dispatch
 * (shape-mode reservation DEFERRED — see events.ts's header, unpinnable
 * this stage), destroy/destroyErr (the NO-USER-_destroy-OVERRIDE default
 * path only — a provided `destroy` option/override refuses by name,
 * unexercised by any claim this stage), the _read underscore dispatch
 * (options-callback AND construction-time override binding), stream.prop
 * scalar reads, readable.flowing, stream.errored. Pass 2 (THIS file's
 * current state): setEncoding + the utf8 StringDecoder (RS_ENCODING's
 * header for the utf8-only scope), pushStrEnc + the defaultEncoding
 * option (RS_PUSH_ENC — push's string form now consults it rather than
 * assuming plain UTF-8), Readable.from(array), for-await via
 * readable.nextChunkDyn, and stream/consumers (sc.text/buffer/json).
 * STILL REFUSING by their own libCall name at the emitter.ts dispatch
 * site, never silently mishandled: the dyn lanes (newDyn/initDyn/
 * pushDyn/pushU — measured not needed by any pass-2 claim, unbuilt).
 *
 * STAGE C PASS 2 (banked claims 1692, 1693, 1695, 1743, 1744, 1747, 1811,
 * 1812, 2313, 2626 — the remaining 10 of pass 1's 19, landed as commit
 * 03a9f78 on main, tier 698→707). Build order (dependency-driven):
 * (1) STRUCTURAL — pipe/unpipe (board #71's flowing-seam note read
 * first), Duplex/Transform/PassThrough construction (.new, direct) AND
 * init (.init, subclass super() — the class-level gate already lifted
 * for all five roots; construction itself still refuses by libCall name,
 * this pass's own job), Transform's _transform/_flush dispatch,
 * shape-mode for 2626 (events.ts's REG_SHAPE scaffolding), 1744's hex
 * decode-out (toStrHelper('hex')). (2) DYN ADAPTERS for 1811/2313 (and
 * the now-loud #73 family) — dyn.callFn + boxFunc/boxBytes/boxStr, plus
 * the pending-check call-graph audit every dispatch site transitively
 * reaching an adapter needs. (3) initDyn (1812) — scalar half
 * independent, callback half after the adapters. (4) listeners()/
 * rawListeners() + the Draft B S-entry (board #66's wasm half). Each
 * lands only when its own pins say so — this header updates as the
 * pass's own claims land, same discipline as pass 1's.
 *
 * STAGE D (increment 22 close, board #77). finished()/pipeline() land as
 * NEW methods on THIS class, not a separate module: the settle contract
 * they need (three-way error/end/premature-close dispatch, the
 * already-closed-at-registration fast path) is settleConsumerCore's own
 * shape, and that method is private to StreamBuilder — reusing it beats
 * re-deriving it behind a file boundary. Pass plan: P1 finished/eos
 * (stream.finished/finishedDyn, sp.finished — a per-stream watcher LIST,
 * RS_WAITER's single-slot precedent generalized since finished()/eos()
 * allow concurrent registrations Node itself supports); P2 pipeline
 * (stream.pipeline/pipelineDyn, sp.pipeline — pairwise pipe() composition
 * + cross-stage destroy propagation, the largest new machine of the
 * stage); P3 rides lower-assert.ts's contract into a new assert.ts file
 * (genuinely separate concern, no StreamBuilder coupling) plus events.ts's
 * listenersOf adapter closures (#75); P4 riders (#72 for-await
 * destroy-on-exit, frontend-only; #76 repro derivation) + close-out. */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type FieldType, type ValType } from "./module.js";
import { LEN, BUF } from "./arrays.js";
import { DK, DYN_KIND, DYN_REF } from "./dyn.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** The %Readable-rooted class's OWN injected prefix field, past the
 * emitter pair (classes.ts's gate lift: vt, EMITTER_REG, EMITTER_NAME,
 * then this one) — the WasmGC translation of C's lazily-allocated
 * stream-state pointer. */
export const STREAM_STATE = 3;

/** `$rState`'s field indices. */
export const RS_HWM = 0; // f64
export const RS_LENGTH = 1; // f64 — buffered byte length
export const RS_HEAD = 2; // chunk ref, nullable
export const RS_TAIL = 3; // chunk ref, nullable
export const RS_FLOWING = 4; // i32: -1 unset, 0 paused, 1 flowing
export const RS_READING = 5; // i32 bool
/** Node's real `state.sync` (the lifted internal/streams/readable source,
 * scratchpad/rev/pb/lift.cjs+lift3.cjs — the gate-review's ground truth):
 * true from CONSTRUCTION, set true again immediately before EVERY
 * `_read()`-driven read cycle and cleared right after that SAME cycle's
 * `_read()` call returns (`callRead`'s own bracket) — NOT a one-time
 * "past construction" latch (the gate-round B2 finding: the prior design
 * cleared this once at a stream's first tick, which is wasm-only
 * invented behavior, not Node's). Serves BOTH of Node's two real
 * consumers of `kSync`: `addChunk`'s direct-emit fast-path condition
 * (`pushCore`) and `onEofChunk`'s sync-vs-deferred 'readable' branch
 * (`pushNullCore`) — one field, matching Node's one bit, not two
 * invented ones. Since `_read` is never called before a stream's first
 * real read cycle, `sync` reads `true` for any push()/push(null) that
 * happens synchronously in the SAME stack that merely registered a
 * listener (1687's pin — `push()` right after `.on('data', cb)` still
 * buffers rather than emitting inline, even though `flowing` already
 * reads `true`), which is what the old two-field design was really
 * chasing without the right mechanism. */
export const RS_SYNC = 6;
export const RS_ENDED = 7; // i32 bool
export const RS_END_EMITTED = 8; // i32 bool
/** NOT one of Node's real bits (Node's own `endReadable()` has no
 * "already scheduled" guard at all — it may re-schedule `endReadableNT`
 * on every qualifying `read()` call, relying on `endReadableNT`'s OWN
 * `!endEmitted` recheck at tick time to make repeats harmless) — kept
 * here as this file's own defensive dedup, strictly reducing redundant
 * ticks without changing any OBSERVABLE outcome for a single end cycle;
 * not flagged for removal by the gate round. */
export const RS_END_SCHEDULED = 9; // i32 bool
export const RS_NEED_READABLE = 10; // i32 bool
export const RS_EMITTED_READABLE = 11; // i32 bool
export const RS_RESUME_SCHEDULED = 12; // i32 bool
export const RS_DESTROYED = 13; // i32 bool
export const RS_ERROR = 14; // errRef, nullable
export const RS_EMIT_CLOSE = 15; // i32 bool
export const RS_AUTO_DESTROY = 16; // i32 bool
export const RS_READ_CLOS = 17; // eq, nullable
export const RS_READ_THUNK = 18; // readThunkSig ref, nullable
export const RS_READABLE_LISTENING = 19; // i32 bool
/** Node's real `state.readingMore` — `maybeReadMore`'s own reentrancy
 * guard (R3: ported now, pass 2's buffering builds on it and its absence
 * distorted downstream behavior — pb/b6 pins `_read` filling to the
 * highWaterMark, which needs this loop to exist at all). */
export const RS_READING_MORE = 20; // i32 bool
/* PASS 2 fields (setEncoding/StringDecoder, for-await, stream/consumers —
 * see this file's header for the design). Kept append-only, matching
 * pass 1's own convention. */
/** 0 = byte mode (default); 1 = utf8 string mode (`setEncoding('utf8')`
 * active). The ONLY decoder this pass ports (measured: 1745/2627 are the
 * sole claims exercising the STATEFUL decode-out StringDecoder, and both
 * are pure utf8 — 2628 is entirely the OTHER direction, push(str,enc)/
 * defaultEncoding = Buffer.from(str,enc), stateless, already covered by
 * typedarrays.ts's fromStrHelper). Any other encoding name refuses BY
 * NAME at the emitter dispatch site (readable.setEncoding's second
 * argument is always a compile-time strLit — lower-stream.ts's own
 * construction — so the refusal is a compile-time name, never a runtime
 * branch guessing at an unported encoding). */
export const RS_ENCODING = 21; // i32 bool (utf8 on/off)
/** The StringDecoder's held-back incomplete UTF-8 tail (0-3 bytes,
 * scr_strdec_tail's ported lookback) — nullable bytes, re-consulted by
 * every subsequent push while RS_ENCODING is on. The chunk LIST itself
 * stays bytes-only (unchanged from pass 1): once decoded, this file
 * RE-ENCODES the decoded text back to utf8 bytes before it ever reaches
 * appendChunk, so no second chunk representation is needed — only the
 * emission step (emitDataFrom) re-decodes back to a string for the dyn
 * box. RS_LENGTH therefore counts utf8 BYTES while encoded where Node
 * counts UTF-16 code units — observable through readableLength AND
 * through push()'s hwm-gated boolean return (S047, registered in the
 * gate's fix round: push("ééé") under hwm 4 answers false here, true in
 * Node). Unexercised by any of this stage's stream claims — they DO
 * push on encoded streams (1745/2627/2629) but every call site discards
 * push()'s return, and none reads readableLength while encoded. */
export const RS_DEC_PENDING = 22; // bytesRef, nullable
/** `push(str)`'s DEFAULT push encoding (the `defaultEncoding` option) —
 * an encTag (ENC_NAMES' index), default 0 (utf8). Orthogonal to
 * RS_ENCODING: this picks how a plain `push(string)` call turns its
 * string into BYTES; RS_ENCODING is the READ-side decoder. Both may be
 * active on the same stream (unverified by any of this stage's six
 * claims in combination — named, not asserted equivalent). */
export const RS_PUSH_ENC = 23; // i32 encTag, ENC_NAMES' index
/** The one parked `nextChunkDyn` continuation (for-await), or null.
 * Single slot: a for-await loop only ever has ONE outstanding call at a
 * time by construction (lowerForAwaitReadable awaits each call before
 * the next). TWO CONCURRENT for-await loops over the SAME stream TRAP
 * LOUDLY at the second park (S049, the gate's fix round — the earlier
 * silent-overwrite form abandoned the first promise unsettled and the
 * program exited 0 with truncated output, the exact silent-wrong-output
 * class rule 1 forbids). Node neither traps nor throws here: it shares
 * ONE cached async iterator and the two loops chain/interleave —
 * machinery this tier doesn't build, so the loud trap is the honest
 * refusal shape. Unreachable by any of the stream claims (verified:
 * none run concurrent iteration). */
export const RS_WAITER = 24; // promRef, nullable
/** 0 = no active stream/consumers subscriber; 1 = text, 2 = buffer, 3 =
 * json (the SC_KIND_* constants below). ONE subscriber at a time — none
 * of the six claims layer two on the same instance. */
export const RS_CONSUMER_KIND = 25; // i32, SC_KIND_*
export const RS_CONSUMER_PROMISE = 26; // promRef, nullable
/** The consumer's growing raw-bytes accumulator — concatenated on every
 * delivered chunk (BEFORE the string/bytes dyn-box choice, so a
 * setEncoding'd source's utf8-reencoded bytes accumulate the same way a
 * plain byte-mode source's do: 2629's r4/r5 "string-chunk stream: text()
 * concatenates the strings, buffer() takes their utf8 bytes" needs
 * exactly this uniform accumulation). text()/json() decode the WHOLE
 * thing once at settle time; buffer() takes it as-is. */
export const RS_CONSUMER_ACC = 27; // bytesRef, nullable
/** `readableObjectMode` — always false EXCEPT a `Readable.from(array)`
 * stream, which Node marks objectMode:true unconditionally (oracle-
 * measured directly: `Readable.from(["a","bc"]).readableObjectMode ===
 * true`, `.readableHighWaterMark === 1` — Node's real `from()` always
 * passes `{objectMode:true, highWaterMark:1}` to the constructor). This
 * tier does NOT implement object-mode's real semantics (count-by-entry
 * buffering) — only the two OBSERVABLE properties or claims read
 * (readableObjectMode, readableHighWaterMark) — a scoped simplification:
 * every hwm-gated decision this file's read/flow machinery makes still
 * uses BYTE/CHAR length, which is safe exactly because for-await (the
 * only consumption mode a fromArr stream reaches this stage) always
 * drains the buffer to empty between chunks, so the `length===0` clause
 * in readCore's own DOREAD computation forces the next `_read()`
 * regardless of what hwm holds — named, not silently assumed
 * equivalent. */
export const RS_OBJECT_MODE = 28; // i32 bool
/** Reentrancy guard for `checkWaiterCore` — found via execution (a real
 * stack overflow, not a theoretical worry): `checkWaiterCore` calls
 * `readCore`, which (its OWN pass-1 logic, unrelated to this pass) may
 * call `callRead()` to prefetch — `_read`'s user body (a `Readable.from`
 * stream's OWN native thunk, in the corpus case that surfaced this) can
 * itself `push()`, whose tail (this pass's own addition) calls
 * `checkWaiterCore` AGAIN, still nested inside the FIRST call's own
 * `readCore`. Left unguarded this recurses without bound (a small
 * `Readable.from(array)` was enough to blow the stack, since hwm=1
 * makes readCore's own "prefetch the next one" doRead condition fire on
 * EVERY read). The guard makes every REENTRANT call a no-op; the
 * OUTERMOST call still completes correctly regardless, because by the
 * time its own (possibly reentrant-triggered) `readCore` call returns,
 * whatever the inner reentrancy pushed is already buffered — the outer
 * call reads and settles it exactly once. */
export const RS_CHECKING_WAITER = 29; // i32 bool
/** True once opClose has RUN (the 'close' event dispatched and any armed
 * consumer settled). scRegisterCore's late-registration test: a consumer
 * armed AFTER this flips relies on nobody — opClose, the only settle
 * point in the normal order, has already come and gone — so registration
 * itself settles immediately via settleConsumerCore (the same three-way
 * logic: RS_ERROR → reject, no RS_END_EMITTED → premature close, else
 * transform the (empty) accumulator per kind). Registration BEFORE this
 * flips — including after push(null) but before 'close' (2629 r7/r8) —
 * is untouched: opClose settles it exactly as before. */
export const RS_CLOSE_EMITTED = 30; // i32 bool
export const RS_FIELD_COUNT = 31;

/* STAGE C fields (Writable's own half — construction/write/end/cork,
 * underscore _write/_final/_destroy dispatch, WS-prefixed internal-state
 * compat view). Kept on the SAME $rState struct as the readable-side
 * fields above (append-only, matching pass 1/2's own convention) rather
 * than a second struct type: the C reference's ScrStreamState already
 * carries both `r` and `w` sub-structs unconditionally (gated by
 * readable_side/writable_side booleans, not by which fields physically
 * exist), and emitAlloc (emitter.ts) seeds STREAM_STATE as one nullable
 * ref regardless of which sides a class has — a second struct type would
 * need a second nullable prefix field and a compile-time-known "which
 * struct" branch at every site that touches state, for no benefit: a
 * Readable-only instance's WS_* fields simply stay at their construction
 * default and nothing ever reads them (the frontend's own STREAM_API_
 * MEMBERS/requireSide gate keeps a pure Readable's writable-side members
 * from ever lowering in the first place). */
/** The write-request queue's own highWaterMark (Node's real
 * writableHighWaterMark; RS_HWM is the readable-side default 65536,
 * duplicated here rather than shared because Readable/Writable hwm are
 * INDEPENDENTLY defaultable — a Duplex may set readableHighWaterMark and
 * writableHighWaterMark to different values, lower-stream.ts's own
 * `streamCtorArgs` head shape already carries them as two separate
 * arguments for the duplex-shaped constructors). */
export const WS_HWM = 31; // f64
export const WS_LENGTH = 32; // f64 — buffered byte length (queued + in-flight)
export const WS_HEAD = 33; // $wReq ref, nullable — the buffered/corked write-request queue
export const WS_TAIL = 34; // $wReq ref, nullable
/** Node's real `state.corked` — a COUNT, not a bool (nested cork() calls
 * stack; writableCorked reads this number directly). */
export const WS_CORKED = 35; // f64
/** A `_write`/`_writev` call is currently in flight (between calling it
 * and its callback running) — Node's real `state.writing`, gates whether
 * `clearBuffer`'s queue-drain loop may pull the next entry synchronously
 * or must wait for `afterWrite`. */
export const WS_WRITING = 36; // i32 bool
/** Node's real `state.sync` on the WRITABLE side — mirrors RS_SYNC's
 * exact role and header: true for the synchronous bracket around a
 * `_write` call (`doWrite`'s own set-true/call/set-false), used by
 * `afterWrite` to decide whether completing synchronously may drain the
 * next queued entry inline (`sync` true: defer via a tick — Node never
 * recurses `_write` synchronously from within another `_write`'s own
 * callback) or immediately (`sync` false: the callback fired on a LATER
 * turn, so calling straight back into `_write` cannot recurse). */
export const WS_SYNC = 37; // i32 bool
/** `end()` was called — Node's real `state.ending` (distinct from
 * `ended`: `ending` flips at the `end()` call itself; `ended` flips once
 * every queued write has actually reached `_write`/`_writev`). */
export const WS_ENDING = 38; // i32 bool
export const WS_ENDED = 39; // i32 bool
export const WS_FINISHED = 40; // i32 bool
export const WS_NEED_DRAIN = 41; // i32 bool
/** Node's real `state.prefinished` — flips once `_final` has run (or was
 * skipped, no override), gating `finishMaybe`'s 'finish' emission exactly
 * like `prefinish` gates it in the lifted source. */
export const WS_PREFINISHED = 42; // i32 bool
export const WS_WRITE_CLOS = 43; // eq, nullable — the bound `_write`/option closure
export const WS_WRITE_THUNK = 44; // writeThunkSig ref, nullable
export const WS_FINAL_CLOS = 45; // eq, nullable
export const WS_FINAL_THUNK = 46; // finalThunkSig ref, nullable
/** `end(cb)`'s own completion callback — fires once (Node's real
 * `state.writable` "finish" listener attached ad hoc by `end`), BEFORE
 * 'finish' listeners run (1688/1741/1811's pin). Not reused across
 * multiple `end()` calls (Node's `end()` after the first is a no-op that
 * still eventually calls a SECOND cb with ERR_STREAM_WRITE_AFTER_END —
 * unbuilt this stage, unclaimed). */
/** `end(cb)`'s own completion callback closure directly (`voidClos().clos`
 * typed, exactly like WREQ_CB_CLOS below — no separate thunk field; see
 * wReqT's header for why the zero-arg shape needs no adapter). */
export const WS_END_CLOS = 47; // voidClos().clos ref, nullable
/** The `_destroy(err, callback)` override/option binding — SHARED across
 * every stream side (Node's `_destroy` is one method regardless of r/w/
 * rw; RS_DESTROYED/RS_ERROR/OP_ERROR/OP_CLOSE are already shared for the
 * exact same reason). Absent (both null): the default path (pass 1's
 * `destroyErrCore` body, now factored into `destroyErrDefaultCore`) runs
 * with no user hook, unchanged. */
export const RS_DESTROY_CLOS = 48; // eq, nullable
export const RS_DESTROY_THUNK = 49; // destroyThunkSig ref, nullable
/** GATE FIX C2/C4: a FIFO of `$wReq` entries whose own per-write callback
 * still needs firing but whose CHUNK was never (and will never be) handed
 * to `_write` — Node discards a destroyed stream's still-queued writes
 * (C4, lifted+measured: `clearBuffer`'s destroyed-path calls each
 * discarded entry's callback with the destroy error) and a write() call
 * that lands on an already-`ending` stream never queues at all (C2,
 * lifted: `_write`'s `kEnding`-check builds `ERR_STREAM_WRITE_AFTER_END`
 * and schedules the callback directly, never touching `writeOrBuffer`).
 * Both routes land here rather than on WS_HEAD/WS_TAIL, which stay
 * reserved for entries that WILL reach `_write`. Fired by OP_FIRE_
 * DISCARDED, scheduled AFTER 'close' (C4's own measured ordering:
 * "_write one / err / close / cb one / cb two"). The error itself is
 * NOT threaded through the call — every callback this tier can compile
 * for `write(chunk, cb)` is the frontend's own zero-arg `() => void`
 * shape (lower-stream.ts fences any callback declaring the error
 * parameter), so Node's real `cb(err)` and this tier's `cb()` agree on
 * every OBSERVABLE a zero-arg JS callback could read (none) — a
 * dyn-valued (JS-lane, checked-dynamic) write callback is a DIFFERENT
 * shape entirely, refused by name before ever reaching this queue
 * (writable.write's own dyn-callback-value guard, gate fix C5). */
export const WS_DISCARDED = 50; // $wReq ref, nullable
/** GATE FIX F2: which of the two ways a stream became destroyed governs
 * where a LATER write() call's own callback lands relative to 'close' —
 * measured, not assumed (three consistent probes: c-err-queue3.ts vs
 * f-write-after-destroy.ts vs f-mech-explicit-vs-autoDestroy.ts, the last
 * pair identical except for the trigger). TRUE only when an in-flight
 * write's OWN error is what destroyed the stream (afterWriteCore's F1
 * branch sets it, nowhere else) — Node fires a LATER same-shape write's
 * callback SYNCHRONOUSLY then, before 'error'/'close' (matches F1's own
 * queue-drain, which is already synchronous). FALSE (the default, and
 * every EXPLICIT `.destroy()` call whether or not it carries an error)
 * means a later write's callback DEFERS past 'close' — writeCore's own
 * F2 branch schedules it via WS_DISCARDED/OP_FIRE_DISCARDED instead of
 * firing inline. One-way like RS_DESTROYED itself: set at most once, at
 * the same moment, never reset. */
export const WS_DESTROY_SYNC = 51; // i32 bool
/** STAGE C PASS 2, pipe(): ONE active pipe relationship per source — no
 * list (S050, registered before this landed: a second simultaneous
 * `.pipe()` call TRAPS rather than silently overwriting or fanning out).
 * RS_PIPE_DEST null means "not currently piping"; the three closure
 * fields are pipeCore's own internal 'data'/'drain'/'end' listeners
 * (events.ts's entryAppend/removeLast — ordinary registered entries,
 * findable later by IDENTITY, exactly Node's own removeListener
 * mechanism), non-null together with RS_PIPE_DEST and null together
 * without it. unpipeCore nulls all four back out after removing them. */
export const RS_PIPE_DEST = 52; // root ref, nullable
export const RS_PIPE_ONDATA = 53; // eq, nullable — the 'data' listener on THIS (the source)
export const RS_PIPE_ONDRAIN = 54; // eq, nullable — the 'drain' listener on RS_PIPE_DEST
export const RS_PIPE_ONEND = 55; // eq, nullable — the 'end' listener on THIS, once=true
/** STAGE C PASS 2, Transform, GATE FIX C2S-1 (remedy iteration 3 — the
 * FINAL truth, after two remedies that came back out): the
 * `allowHalfOpen` OPTION's value (duplex.new/transform.new/
 * passthrough.new's own construction), stored FAITHFULLY — literal or
 * runtime, `true` or `false`, no gate of any kind — so `stream.prop:
 * allowHalfOpen` reads back exactly what the program passed, AND fully
 * WIRED: `false` auto-ends the writable side once the readable side
 * ends, matching Node's real `endReadableNT` (opEnd's own branch-
 * selection guard + OP_AUTO_END's tick body, that header has the full
 * mechanism story — measured directly against v24.18.1's
 * `internal/streams/readable.js`, not assumed). Node's own default is
 * `true`; this file initializes it that way too (stateEnsure's own
 * default-fields precedent) so a plain Readable/Writable (never touched
 * by duplex/transform/passthrough construction at all) still answers the
 * property correctly if ever read on a non-duplex-shaped instance (Node's
 * own `readable.allowHalfOpen` on a plain Readable answers `undefined`, a
 * DIFFERENT, unmeasured shape — STREAM_PROP_MEMBERS's own dispatch is
 * scoped to duplex-shaped classes only, so this field's value is simply
 * never read for a plain Readable/Writable).
 *
 * HISTORY (worth stating plainly — three remedy iterations on one gate
 * finding, each forced by measured evidence): (1) a compile-time refusal
 * for a literal `false`, cheap while it cost nothing; (2) extended to a
 * runtime trap for the non-literal case, landed alongside; both came OUT
 * once the reviewer's gate measured that they unclaim 1742 (this pass's
 * own claim, whose entire exercised surface — construct-with-false,
 * write/end, flag read-back — this tier already handles byte-exactly,
 * since its own execution trace never reaches the auto-end mechanism at
 * all). SEMANTICS.md briefly carried a draft S051 for THIS trap; it
 * never merged, so it was withdrawn rather than left registered for a
 * divergence that no longer exists here. The number was NOT left
 * permanently retired, though — it is now S051 for a genuinely
 * different divergence (the dyn-adapter phase's completion-callback
 * truthiness gap, `dynDoneClosFor`'s own trap) — a real reuse, not a
 * dangling citation; SEMANTICS.md S051 is live again, just for
 * something else entirely than what this comment used to point at. */
export const WS_ALLOW_HALF_OPEN = 56; // i32 bool
/** CORRECTION (1690, both-sides autoDestroy): TRUE only for a stream
 * constructed via duplex.new/transform.new/passthrough.new (set
 * alongside WS_ALLOW_HALF_OPEN at those three construction sites, same
 * lockstep) — FALSE (the default) for readable.new/writable.new's own
 * single-sided construction. Node's real autoDestroy waits for BOTH
 * `_writableState.finished` AND `_readableState.endEmitted` before
 * actually destroying a duplex-shaped stream (measured directly,
 * ORDER-INDEPENDENT — p6a: end() then push(null); p6b: push(null) then
 * end() — `destroyed` stays false through BOTH 'finish' and 'end' either
 * way, only flipping true once both have fired, right before 'close').
 * A single-sided Writable/Readable has no "other side" to wait for at
 * all, so it keeps today's behavior (destroy immediately once ITS own
 * side completes) — this flag is what lets opFinish/opEnd tell the two
 * cases apart at runtime, since all five classes share one struct with
 * no other type tag. */
export const WS_DUPLEX_SHAPED = 57; // i32 bool
/** STAGE D (finished()/eos(), board #77). Which side(s) a finished()/
 * eos() watcher on THIS instance should watch for premature-close —
 * Node's own `readable`/`writable` eos() option booleans, defaulted from
 * `isReadableNodeStream`/`isWritableNodeStream`, which read the RUNTIME
 * OBJECT's actual interface, not any call-site's declared type. Gate
 * review caught a real divergence in the first cut of this field (a
 * compile-time strLit threaded through the IR from the call site's
 * static TypeScript type): `finished(d, cb)` where `d`'s STATIC type is
 * narrowed/upcast to `Writable` but the RUNTIME object is a Duplex —
 * Node still waits for BOTH sides (measured directly: a Duplex whose
 * writable side finishes but whose readable side never ends does not
 * fire `finished()`'s callback at all, even after the writable side is
 * long done); a static-type mechanism would have fired early. STAMPED
 * AT CONSTRUCTION instead — every $rState-minting path unconditionally
 * knows its own root kind, so the stamped value tracks the OBJECT the
 * way Node's own runtime check does, upcasts included, with ZERO
 * frontend/IR change (the original `[recv, cb]` / `[recv]` libCall
 * shapes are unchanged — this field is backend-only, so the LLVM/C
 * lanes, which already handle those exact shapes today, see no diff at
 * all). SEVEN stamp sites (gate finding v4/v5 — a first pass found only
 * the FOUR static-literal construction blocks plus fromArrCore and
 * missed the two `.initDyn` blocks, which mint their own state
 * independently and are the exactly-two classes with DIFFERENT
 * sidedness, so the WS_DUPLEX_SHAPED covering-set precedent — safe
 * because no duplex/transform/passthrough `.initDyn` form exists — does
 * NOT transfer): readable.new/init, readable.initDyn, writable.new/init,
 * writable.initDyn, duplex.new/init, transform.new/init+passthrough.
 * new/init, fromArrCore (Readable.from). FIN_SIDE_UNSET's own header
 * explains the sentinel-default/refuse-by-name net for a missed site.
 *
 * UPCAST REACHABILITY — split by branch, not a blanket "unreachable"
 * (an earlier draft of this comment claimed the whole upcast angle was
 * SC1090-fenced; that was FALSE PROSE, corrected here after the gate
 * measured otherwise — do not restate the blanket version). Two
 * DIFFERENT upcast shapes exist relative to RUNTIME_STREAM_CLASSES'
 * hierarchy (ir/nodes.ts): SAME-branch (%Duplex's own base class IS
 * %Readable — Transform and PassThrough both root at %Duplex, so they
 * inherit this too) is fully EXPRESSIBLE AND OBSERVABLE TODAY —
 * `const r: Readable = someDuplex;` compiles and runs, and DOES produce
 * the static-vs-runtime sidedness divergence this field exists to
 * avoid (measured directly against Node: a Duplex held through a
 * Readable-typed binding, readable side ended, writable side never
 * finished, then destroyed — finished() reports
 * ERR_STREAM_PREMATURE_CLOSE, never "clean"; `wasm-stream-finished.
 * test.ts`'s Readable-binding pin pins this exact shape end to end,
 * compiled and run, not just argued). CROSS-branch (`finished(w, cb)`
 * where `w`'s static type is `Writable` but the constructed object is a
 * Duplex — Writable sits on its own branch off the emitter class, never
 * a base of Duplex) is the ONLY angle still SC1090-fenced ("'Duplex'
 * values where 'Writable' is expected is not supported yet"),
 * independent of finished() entirely; no compiled pin of THAT specific
 * angle is possible until cross-branch upcasting lands. Same-branch
 * siblings not separately pinned (one mechanism, the Readable-binding
 * pin carries the class): Transform→Readable, PassThrough→Readable,
 * Transform→Duplex, PassThrough→Duplex, and user subclasses of any
 * duplex-shaped root held through a Readable- or Duplex-typed binding —
 * all correct for the identical reason (RS_SIDES tracks the
 * CONSTRUCTED OBJECT, never the binding's static type, no matter which
 * root or how many subclass layers sit in between). */
export const RS_SIDES = 58; // i32: FIN_SIDE_R/W/RW
/** The watcher LIST head — every `stream.finished`/`finishedDyn`/
 * `sp.finished` registration on this instance appends one
 * `$w.rs.finEntry` node here (a real list, not a single slot like
 * RS_WAITER: a pipeline's own middle stage gets TWO independent
 * registrations — one writable-only from being piped into, one
 * readable-only from piping out, Node's real pairwise `pipe()` +
 * `eos()` composition — so P1 builds the list even though its own two
 * claims never register more than one watcher per stream). Fired (and
 * the list detached-then-cleared FIRST, for reentrancy — mirrors the
 * native lane's `scr_stream_notify_finished`) from `opClose`, right
 * after `RS_CLOSE_EMITTED` is set — the willEmitClose:true default path
 * (probe13). A registration arriving AFTER `RS_CLOSE_EMITTED` is already
 * true schedules OP_FIN instead of waiting for a 'close' that already
 * happened (mirrors Node's own always-schedule-never-sync eos()
 * contract, probe01/probe12). */
export const FIN_HEAD = 59; // ref $w.rs.finEntry, nullable
/** FIX ROUND (P2-1, gate finding) — a TRANSIENT, per-write bit: did the
 * write that JUST landed (inside THIS `write()` call, via `doWriteCore`)
 * error SYNCHRONOUSLY? Node's real `write()` return-value formula
 * reflects `state.errored`/`state.writable` becoming false the INSTANT
 * a synchronous `_write` callback errors (measured directly: `const ret
 * = w.write('x')` over a synchronously-erroring `_write` gives `ret ===
 * false` and `w.errored` a real Error, both readable immediately after
 * `write()` returns — well before `destroy()`'s own deferred `destroyed
 * = true` / 'error' / 'close'). `writeCore`'s own formula (GATE FIX C3's
 * `WS_LENGTH < WS_HWM`, otherwise unchanged) needs this ONE extra
 * signal to match — nothing else.
 *
 * DELIBERATELY NOT `RS_ERROR` (set early): Node's `state.errored` really
 * IS synchronous, and stamping RS_ERROR early would be the CLOSER port —
 * but RS_ERROR already has readers (checkWaiterCore's consumer-settle
 * path, opError's own dispatch, finComputeErr) built and gate-tested
 * against the LATE (deferred-destroy) stamp; moving its own timing would
 * be an unaudited-sibling hazard across all of them for a fix this
 * narrow. This flag is a proxy for `state.errored`'s role in `write()`'s
 * return formula ONLY — no other reader may ever consult it. If some
 * FUTURE divergence traces to a reader genuinely needing early
 * errored-state, that is the signal for a full RS_ERROR-timing audit,
 * not for widening this flag's use.
 *
 * RESET DISCIPLINE: `writeCore`'s own entry resets this to false before
 * dispatching (never carried across calls — a stale true would force
 * every SUBSEQUENT healthy write's return to false, a spurious-pause/
 * hang-class bug of exactly the kind this whole round is about).
 * `writeDoneLandingCore` sets it true, unconditionally, whenever `err`
 * is non-null — BEFORE the WS_SYNC-gated defer decision, so it is
 * visible the instant `doWriteCore()` returns back into `writeCore`,
 * regardless of whether the callback landed synchronously or not (an
 * async-landing error is caught by the SAME check just as correctly —
 * `writeCore` has already returned its OWN answer for THAT call by
 * then, so the flag is simply unread until the NEXT `write()` resets
 * it). No claim exercises write-after-a-sync-error-without-destroy (a
 * synchronous error always routes to `destroyErrCore` on the SAME
 * stream), so this pass does not pin that combination separately. */
export const WS_SYNC_ERRORED = 60; // i32 bool, transient
/** STAGE D P4 (rider #72): set by `destroyAbortedCore` right before the
 * synthesized AbortError it builds reaches `opError` — Node's real
 * async-iterator break-destroy stores that AbortError as the stream's
 * OWN error (measured: `stream.errored` reads it immediately, and an
 * attached 'error' listener DOES fire) but NEVER crashes the process
 * merely because nothing was watching at that instant (measured: a bare
 * `break` with no listener/consumer/waiter attached completes silently
 * — no uncaught-error crash at any point until something LATER actually
 * observes the error). Node's own mechanism is an internal `eos()`
 * listener the async generator registers as a side effect of its own
 * setup, permanently counting as "handled" — this tier does not model
 * that listener, so this flag reproduces its ONE externally-observable
 * consequence (opError's unhandled-crash fallback never fires for THIS
 * error) directly. RESET DISCIPLINE: single-use, exactly like
 * RS_CHECKING_WAITER's reentrancy guard — `opError` reads it into a
 * local and clears it to false in the SAME pass, before making its
 * handled/unhandled decision, so a stream destroyed a SECOND time (via
 * this same path or a plain error) never accidentally inherits a stale
 * suppression (destroy is idempotent past the first call regardless,
 * per destroyErrCore's own RS_DESTROYED gate, so in practice this only
 * ever fires once per stream — the explicit clear is defensive, not
 * load-bearing, and documented as such). */
export const RS_ERROR_ABORT_SILENT = 61; // i32 bool, transient
export const WS_FIELD_COUNT = 62;

/** RS_SIDES's own values — a bare Readable's finished() watches ONLY the
 * readable side (a pure Writable never reaches RS_END_EMITTED, so
 * watching it there would wrongly report premature-close on every clean
 * Writable finish — 1813's own `w` case pins exactly this); a Duplex/
 * Transform/PassThrough watches both (the upcast probe above pins the
 * "both, unconditionally" half). Pipeline's OWN internal per-stage
 * watchers (P2) do NOT read this field — they're role-based (source=R-
 * only, dest=W-only) regardless of the stage's own RS_SIDES, fixed by
 * the backend itself. */
export const FIN_SIDE_R = 0;
export const FIN_SIDE_W = 1;
export const FIN_SIDE_RW = 2;
/** FIX ROUND (gate finding, v3/v4): stateEnsure's DEFAULT before any
 * construction site stamps a real value. Deliberately NOT a plausible
 * value (R/W/RW) — every construction site MUST overwrite this, and
 * unlike WS_DUPLEX_SHAPED's bool default (false is safe unstamped: no
 * duplex/transform/passthrough .initDyn form exists, so the covering
 * set is genuinely complete for it), RS_SIDES has NO safe default: the
 * two `.initDyn` classes (readable/writable) are exactly the two with
 * DIFFERENT sidedness, so whichever single value was chosen, one of
 * them would be silently wrong (RW breaks a dyn Readable's clean end;
 * R breaks a dyn Writable's clean finish; W breaks the Readable case) —
 * a demonstrated property, not a precaution. `finComputeErr` refuses BY
 * NAME on UNSET rather than guessing, converting any missed stamp site
 * (now or in a future construction path) into a loud diagnostic instead
 * of a silent miscompile. */
export const FIN_SIDE_UNSET = 3;

/** FE_KIND — how to fire this watcher. CB: a genuine typed closure,
 * called through FE_THUNK (destroyThunkSig's ABI). DYN: a dyn-boxed
 * function value, called through dyn.callFn with zero args on success
 * (Node's own `callback.call(stream)`, no args) or one boxed-error arg
 * on failure. PROMISE: FE_CLOS is actually a promRef (structs are `eq`
 * subtypes in WasmGC, so the shared field just gets ref.cast at use
 * time) — sp.finished's own form, settled via promSettle directly, no
 * user closure at all. */
export const FIN_KIND_CB = 0;
export const FIN_KIND_DYN = 1;
export const FIN_KIND_PROMISE = 2;
/** STAGE D P2 (pipeline, board #77). A pipeline() stage's own destroyer-
 * style watcher (rD-node's own `destroyer(stream, reading, writing)` —
 * one per STAGE, not one per adjacent pipe() pair; distinct from
 * pipeCore()'s own byte-transfer wiring, which has no eos()/premature-
 * close logic of its own). FE_CLOS holds the pipeline ctx (`eq`, cast at
 * use time — the SAME "shared field, per-kind cast" convention
 * FIN_KIND_PROMISE already established for a promRef); FE_ROLE (a NEW
 * field, see below) carries which side(s) THIS stage watches — POSITION-
 * derived (stage 0 = R, last stage = W, middle = RW), computed by the
 * backend from the stage's place in ITS OWN pipeline() call, never from
 * any call-site's static TypeScript type — carries none of the
 * finished()/eos() upcast divergence risk RS_SIDES's own header
 * documents, since pipeline's role assignment has no analogous "declared
 * type vs runtime object" axis at all. */
export const FIN_KIND_PIPELINE = 3;

/** `$w.rs.finEntry`'s field indices (the struct type itself lives on
 * `StreamBuilder.finEntryT()`, below — needs `destroyThunkSig()`
 * resolved first, so it can't be declared at module scope like the
 * chunk/tick structs are). No per-entry sides field for CB/DYN/PROMISE:
 * RS_SIDES lives on the STREAM (construction-stamped), not the watcher —
 * every entry on one stream shares it. FE_ROLE is the one exception —
 * meaningful ONLY for FIN_KIND_PIPELINE entries (ignored/zero for the
 * other three kinds), see FIN_KIND_PIPELINE's own header for why this
 * one legitimately needs a per-entry field where CB/DYN/PROMISE do not. */
const FE_NEXT = 0;
const FE_KIND = 1;
const FE_CLOS = 2;
const FE_THUNK = 3;
const FE_ROLE = 4;

/** `$w.rs.pipelineCtx`'s field indices — one per `pipeline()`/
 * `pipelineDyn()`/`sp.pipeline()` call, GC-allocated, shared by every
 * per-stage watcher/listener that call registers (captured via
 * FIN_KIND_PIPELINE's own FE_CLOS, and via the raw per-stage 'error'
 * listener closures pipelineRegisterCore builds). No LAST_STAGE field:
 * `STAGES[N-1]` already holds it, and Node's own contract IS the final
 * destination stage, no separate bookkeeping needed. FINAL_THUNK reuses
 * `destroyThunkSig()`'s exact ABI, same as FE_THUNK — lower-stream.ts's
 * own `lowerEosCallback` tuple is `[errorOrNull(L)]` for pipeline's
 * callback exactly like finished()'s (confirmed by reading the actual
 * lowering, not assumed), so the lifted closure never has more than one
 * extra param beyond `this` — `finThunkFor` (P1) is reused VERBATIM for
 * pipeline's own typed callback, no new thunk-building function. */
const PCTX_N = 0;
const PCTX_CLOSED_COUNT = 1;
const PCTX_ERRORSET = 2;
const PCTX_ERROR_IS_PLACEHOLDER = 3;
const PCTX_ERROR = 4;
const PCTX_FINAL_KIND = 5;
const PCTX_FINAL_CLOS = 6;
const PCTX_FINAL_THUNK = 7;
const PCTX_STAGES = 8;

/** `$wReq`'s field indices — one queued write entry (a chunk plus its
 * own completion callback; `cb` is nullable since a plain `write(chunk)`
 * with no callback is common). Mirrors `$rChunk`'s shape. */
export const WREQ_BYTES = 0;
export const WREQ_CB_CLOS = 1;
export const WREQ_NEXT = 2;

export const SC_KIND_TEXT = 1;
export const SC_KIND_BUFFER = 2;
export const SC_KIND_JSON = 3;

/** Buffer-encoding name -> the runtime's encTag (RS_PUSH_ENC's own
 * numbering, and pushStrEnc's third argument) — the SAME seven canonical
 * spellings lower-containers.ts's `knownBufEncoding` already folds every
 * alias into, so every literal the frontend admits has an entry here
 * (exhaustive-dispatch discipline: `fromStrByEnc` below switches on all
 * seven, not just the three 2628 exercises). */
export const ENC_NAMES = ["utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le"] as const;
export function encTagOf(name: string): number | null {
  const i = ENC_NAMES.indexOf(name as (typeof ENC_NAMES)[number]);
  return i < 0 ? null : i;
}

/** `$rChunk`'s field indices — one pushed entry, an immutable payload plus
 * a mutable consumed-offset (partial takes advance `off` rather than
 * re-slicing the remainder on every read). */
export const CHUNK_BYTES = 0;
export const CHUNK_OFF = 1;
export const CHUNK_NEXT = 2;

/** `$rTick`'s field indices — this file's own private FIFO node (the
 * scr_st_tick data half; the raw marker riding nexttick.ts's queue is the
 * dispatch half, see `scheduleTick`). */
const RT_ROOT = 0;
const RT_OP = 1;
const RT_NEXT = 2;

/** STAGE D P2's OWN private FIFO node — `$w.rs.pipelineTick` (the extra
 * nextTick hop probe12 measured for pipeline's final callback, mirroring
 * `$rTick`'s own shape exactly, deliberately SEPARATE from it rather
 * than reusing it: `$rTick`'s own RT_ROOT field is declared as
 * `rootRef()` — a %Readable-hierarchy class — and every existing op
 * body structGets it as that exact type with no cast; widening it to
 * carry an unrelated pipeline-ctx struct would mean touching every
 * existing op's dispatch (P1's own committed, gate-approved code) for a
 * P2-only need. A dedicated single-purpose queue costs one small struct
 * + one pair of globals and touches nothing already landed. Only ONE
 * kind of work item ever rides this queue (fire this ctx's final
 * callback), so there is no op-code field at all — PT_NEXT is the only
 * other field. */
const PT_CTX = 0;
const PT_NEXT = 1;

/** FIX ROUND (P2-1, gate finding) — `$w.ws.writeCompletion`'s own field
 * indices: a deferred `_write`/`_transform` completion-callback landing,
 * mirroring Node's real `onwrite`'s `state.sync` check (measured
 * directly: a plain synchronous `_write` callback's continuation —
 * success OR error — fires strictly on a LATER turn than the script's
 * own synchronous continuation, interleaved with `process.nextTick`
 * order, never inline). `writeDoneLandingCore`'s own header has the
 * full mechanism story and why this is a SEPARATE mini-queue rather
 * than reusing `$rTick`/`pipelineTick` (the SAME "one dedicated queue
 * per genuinely distinct work-item shape" precedent `pipelineTick`'s
 * own header already established). */
const WCT_ROOT = 0;
const WCT_ERR = 1;
/** LAYER 5 (afterWriteCore split): the completed write's own per-write
 * callback closure, captured by `afterWriteHeadCore` at pop time and
 * carried through the queue to whichever tail eventually fires it —
 * mirrors Node's own `cb` LOCAL PARAMETER capture (`process.nextTick
 * (afterWrite, stream, state, 1, cb)`/`onwriteError(stream, state, er,
 * cb)`): each completion's own `cb` is captured independently, per call,
 * never a single shared mutable field a NESTED completion (dispatched by
 * this same layer's always-immediate queue-continuation) could clobber
 * before the outer one's tail reads it back. */
const WCT_CB_CLOS = 2;
const WCT_NEXT = 3;

export const OP_READABLE = 0;
export const OP_RESUME = 1;
export const OP_END = 2;
export const OP_ERROR = 3;
export const OP_CLOSE = 4;
/** Node's real `maybeReadMore_` tick (R3) — a THIRD scheduled callback
 * distinct from `emitReadable_`'s own tick, per the lifted source
 * (lift2.cjs's `maybeReadMore`/`maybeReadMore_`). */
export const OP_READMORE = 5;
/** Node's real `nReadingNextTick` (lift2.cjs's `Readable.prototype.on`
 * override, the 'readable' arm's empty-buffer branch): a bare
 * `process.nextTick(() => stream.read(0))`, distinct from every other
 * tick here — found via 2572's regression (a synchronous `readCore` call
 * from `onReadableAdded` clears `sync` BEFORE a same-turn `push(null)`
 * runs, which flips `onEofChunk`'s branch and produces an extra
 * 'readable' cycle Node never fires; Node genuinely defers this one). */
export const OP_PRIME_READ = 6;
/** STAGE C: 'drain' (writeCore's below-hwm answer having gone false and
 * the buffered length having drained back to zero — Node's real
 * `onwriteDrain`/`afterWrite` condition). */
export const OP_DRAIN = 7;
/** STAGE C: 'finish' — scheduled once `_final` (or its absence) has
 * called back, mirroring 'end'/'close''s own tick-deferred emission (the
 * whole file's convention: every deferred stream event schedules, never
 * fires inline off a completion callback that might itself be sync). */
export const OP_FINISH = 8;
/** GATE FIX C2/C4: fires every WS_DISCARDED entry's per-write callback
 * (zero-arg — see WS_DISCARDED's own header for why no error value is
 * threaded through) and clears the list. Scheduled AFTER OP_CLOSE
 * (C4's own measured ordering places both discarded callbacks after
 * 'close'). */
export const OP_FIRE_DISCARDED = 9;
/** GATE FIX (C2S-1, remedy iteration 3 — the refuse/trap remedies from
 * iterations 1-2 came back OUT once measurement showed 1742's own claim
 * exercises exactly the shape they broke): Node's real `endWritableNT`
 * (lift2.cjs's `internal/streams/readable.js`, v24.18.1, fetched
 * directly) — `allowHalfOpen: false`'s auto-end-the-writable-side-when-
 * the-readable-side-ends mechanism. NOT a listener (measured: it is
 * INLINE code in `endReadableNT`, the SAME internal function that fires
 * 'end', scheduling this AS ITS OWN SEPARATE `process.nextTick` call —
 * confirmed both by reading the source directly and by an ordering probe
 * showing a THIRD, later-queued nextTick printing before 'end' itself,
 * i.e. 'end' takes multiple tick-hops from whatever triggered it, ruling
 * out a same-tick synchronous listener, which is what `entryAppend`-ing a
 * real 'end' listener would have produced instead). `opEnd`'s own
 * branch-selection guard decides whether to schedule this tick AT ALL
 * (mirroring `stream.writable && allowHalfOpen === false`); this tick's
 * OWN body re-checks the same four flags at RUN time (mirroring
 * `endWritableNT`'s own `stream.writable && !writableEnded &&
 * !destroyed` — state can move in the tick that separates scheduling
 * from firing), then calls `endCore` exactly like `pipeOnendThunk`'s own
 * `dest.end()` does (this pass's own precedent, verbatim null-chunk/
 * null-cb shape). */
export const OP_AUTO_END = 10;
/** STAGE D: a `finished()`/`eos()` registration arriving AFTER
 * `RS_CLOSE_EMITTED` is already true — Node's eos() always schedules
 * (`process.nextTick`), even for an already-terminal stream (probe01,
 * probe12); this tick's body just re-runs the same fire-and-clear pass
 * `opClose` uses (`fireFinListCore`), which is a correct no-op if nothing
 * new landed in FIN_HEAD between scheduling and dispatch. */
export const OP_FIN = 11;

export interface StreamDeps {
  /** The %Readable hierarchy ROOT's own struct — every general helper's
   * receiver parameter, mirroring events.ts's `rootRef`/`rootStruct`. A
   * subclass struct is a wasm SUBTYPE (classes.ts's gate lift), so
   * upcasts are free. */
  rootRef: () => ValType;
  rootStruct: () => number;
  bytesRef: () => ValType;
  strRef: () => ValType;
  /** %w.bytes.length — (bytes) -> f64. */
  bytesLength: () => number;
  /** %w.bytes.slice:u8 — (bytes, f64 start, f64 end) -> bytes, a fresh
   * copy over relative/clamped indices. */
  bytesSlice: () => number;
  /** %w.bytes.fromStr:utf8 — (str) -> bytes, `push(str)`'s plain-UTF-8
   * decode (pushStrEnc's explicit-encoding form is pass 2). */
  bytesFromStrUtf8: () => number;
  errRef: () => ValType;
  /** The exception cell's kind global — nonzero after a call means an
   * uncaught throw happened; the caller (nexttick.ts's drain, or this
   * file's own dispatcher) traps. */
  excKind: () => number;
  dynArrRef: () => ValType;
  dynArrBufType: () => number;
  dynArrStructType: () => number;
  /** dyn.ts's boxBytes — boxes a raw bytes ref into a dyn BYTES value for
   * the 'data' event's one-element tuple. */
  boxBytes: (c: Code, pushPayload: (c: Code) => void) => void;
  /** dyn.ts's pushNewBytesPayload — wraps a raw bytes ref into the
   * `{bytes, isBuffer}` box `boxBytes`'s own payload actually expects
   * (NOT the raw bytesRef itself — dynCheckHelper's bytes<u8> arm casts
   * to this exact wrapper shape, and a bare bytesRef there is an illegal
   * cast at unbox time). Every chunk this file boxes is a real Buffer
   * (Buffer.isBuffer() is always true for a stream chunk), so `isBuffer`
   * is fixed true at the call site, not threaded through as a param. */
  pushBytesPayload: (c: Code, pushBytes: (c: Code) => void) => void;
  /** events.ts's general dispatch — 'data'/'readable'/'end'/'close' all
   * ride this SAME path any user-defined event uses (the emitData ABI
   * decision above). */
  emitDispatch: () => number;
  /** events.ts's `(root, name) -> f64` listener count — used to gate the
   * direct-emit fast path ("has a 'data' listener"). */
  countOf: () => number;
  hasErrorListeners: () => number;
  errDispatch: () => number;
  /** Push an interned string literal onto `c`'s stack. */
  lit: (c: Code, s: string) => void;
  /** Build a FRESH error VALUE (not committing to the exception cell) —
   * the construction half of emitter.ts's `emitSetCellError`, for errors
   * this file raises itself (ERR_STREAM_PUSH_AFTER_EOF, ERR_METHOD_NOT_
   * IMPLEMENTED). */
  buildErrorLit: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
  /** Commit an already-built, DYNAMICALLY-typed error reference (already
   * on the stack via `pushErr`) to the exception cell as an uncaught
   * throw — the trap fires at the caller (nexttick.ts's drain loop
   * already checks `excKind` after every dispatched entry). */
  setUncaughtError: (c: Code, pushErr: (c: Code) => void) => void;
  /** If the exception cell holds a pending OBJ-kind exception rooted in
   * %Error (a genuine Error instance/subclass — the only shape this
   * tier's `RS_ERROR` slot can hold), pushes it (errRef, non-null) and
   * CLEARS the cell — `callRead`'s D2 fix, `errorOrDestroy(this, err)`'s
   * equivalent, inlined since `_read`'s call site has no AST try/catch
   * node to hang a catch block off of. Otherwise pushes null and leaves
   * the cell untouched (a non-Error throw keeps propagating through the
   * ordinary pending-check path — named, not silently dropped: D2 pins
   * only the Error-shaped case, pb/f7's shape). */
  tryCatchAsError: (c: Code) => void;
  /** nexttick.ts's raw-marker seam — the stage-0 queue every deferred
   * stream emission rides (this file's own header). */
  enqueueRaw: () => number;
  rawFnType: () => number;
  /** %w.bytes.new:u8 — (f64 len) -> bytes, a zeroed buffer (the empty-
   * read/no-data-available answer needs a real zero-length bytes value
   * in a couple of paths, not a null). */
  bytesNewLen: () => number;
  /** The raw `i8` storage array type (typedarrays.ts's `bufType()`) —
   * needed alongside `bytesStructType` for hand-rolled multi-chunk
   * concatenation (`array.copy` over the shared byte-granular storage,
   * the SAME representation typedarrays.ts's own slice/concat helpers
   * use — read directly rather than duplicated through a Vec<bytes>
   * dependency this file has no other use for). */
  bytesBufType: () => number;
  /** The `$bytes` struct type index — field 0 storage (ref array i8),
   * field 1 off (i32 bytes), field 2 len (i32 elements); typedarrays.ts's
   * own private layout, stable and read here by hand for the same reason
   * as `bytesBufType`. */
  bytesStructType: () => number;

  /* ── PASS 2 additions ──────────────────────────────────────────────── */

  /** %w.bytes.toStr:utf8 — (bytes<u8>) -> str, the WHATWG maximal-subpart
   * decode (typedarrays.ts's `toStrHelper`, already corpus-proven by
   * Buffer.prototype.toString) — reused verbatim for setEncoding's
   * decode-out direction; never throws. */
  toStrUtf8: () => number;
  /** %w.bytes.fromStr:<enc> — (str) -> bytes<u8>, keyed by ENC_NAMES'
   * index (typedarrays.ts's `fromStrHelper`, one function per canonical
   * encoding, already interned/proven elsewhere for Buffer.from). Used
   * both by pushStrCore's RS_PUSH_ENC dispatch and by the re-encode half
   * of the utf8 decode step. */
  fromStrByEnc: (encTag: number) => number;
  /** dyn.ts's boxStr — boxes a raw string ref into a dyn STR value (the
   * encoded-mode 'data' payload and sc.text's promise fulfillment). */
  boxStr: (c: Code, pushValue: (c: Code) => void) => void;
  /** dyn.ts's own dyn value ref type — needed as an `ifResult` type
   * wherever this file branches between `boxStr`/`boxBytes` (both box TO
   * this same type). */
  dynRef: () => ValType;
  /** dyn.ts's undefinedGlobal — the immortal dyn `undefined` singleton,
   * for-await's EOF sentinel (lowerForAwaitReadable's `dynTest
   * "undefined"` check). */
  undefinedDynGlobal: () => number;
  /** promises.ts's promise type/ref, mint, and settle — the machinery
   * nextChunkDyn/sc.text/sc.buffer/sc.json return into, and that
   * statemachine.ts's OWN compiled `await` already knows how to park on
   * and resume from (no new scheduling machinery needed here — see this
   * file's header). */
  promRef: () => ValType;
  promMint: () => number;
  /** %w.async.settle(p, kind, f64, ref, pre, state) — state 1 fulfilled,
   * 2 rejected; kind is one of `excTag`'s five tags, matching the
   * exception cell's own payload encoding (promises.ts's header: a
   * promise payload rides the identical (kind,f64,ref,pre) triple). */
  promSettle: () => number;
  /** The exception-cell payload tags settle's `kind` argument takes —
   * f64/bool/str numeric-ish payloads, ref for an arbitrary GC ref (dyn
   * boxes and raw bytes both ride this one), obj for an Error-hierarchy
   * instance (needs `pre` computed via `errPreOf`). */
  excTag: { f64: number; bool: number; str: number; ref: number; obj: number };
  /** An already-evaluated errRef's DYNAMIC class-interval position
   * ("pre"), pushed as an i32 — the generic vtable read
   * (`CLASS_VT`/`CI_PRE`) emitter.ts's own `setUncaughtError` already
   * uses inline, factored out so this file's new reject paths (an
   * observed RS_ERROR re-thrown into a promise rejection) can restore
   * the SAME dynamic class a `catch (e) { e instanceof Error }` needs. */
  errPreOf: (c: Code, pushErr: (c: Code) => void) => void;
  /** %w.json.parse(text) -> dyn, OR a pending SyntaxError left in the
   * exception cell (json.ts's own contract — the caller must check
   * `excKind`/use `tryCatchAsError` after calling, exactly like any other
   * may-throw helper this file already calls). sc.json's parse step. */
  jsonParse: () => number;
  /** The array argument's VecInfo pieces (arrays.ts) for `readable.
   * fromArr` — struct/bufType/elemVal for whichever of the two concrete
   * shapes (array<string>, array<bytes<u8>>) the call site has, decided
   * at compile time by the `strings` boolLit lower-stream.ts always
   * supplies. */
  vecStruct: (strings: boolean) => number;
  vecBufType: (strings: boolean) => number;
  vecElemVal: (strings: boolean) => ValType;

  /* ── STAGE C additions ────────────────────────────────────────────── */

  /** The shared zero-arg void closure pair (emitter.ts's own
   * `closPairFor([], [])`, the SAME identity every `() => void`-typed
   * value in the whole program maps to) — every `write(chunk, cb)`/
   * `end(cb)` user callback lowers to exactly this shape (wReqT's own
   * header), so this file calls it back directly rather than building a
   * second, redundant closure-pair machinery of its own. */
  voidClos: () => { clos: number; fn: number };

  /* ── STAGE C PASS 2 additions: pipe() ─────────────────────────────── */

  /** events.ts's `(root, name, clos, thunk, orig, once, prepend) -> void`
   * — the SAME registration path a user `.on()`/`.once()` call goes
   * through (emitter.ts's own dispatch), reused directly for pipe()'s
   * three internal 'data'/'drain'/'end' listeners rather than inventing
   * a parallel registry. */
  entryAppend: () => number;
  /** events.ts's `(root, name, cb) -> void` — off/removeListener by
   * IDENTITY (the LAST matching entry), the exact mechanism Node's own
   * unpipe() uses (its `src.removeListener('data', ondata)`). */
  removeLast: () => number;
  /** dyn.ts's `$dyn` struct type index — needed raw (not the `dynRef()`
   * ValType wrapper already above) wherever this file reads a dyn
   * value's OWN kind tag directly (pipe's ondata thunk: Node forwards
   * whatever 'data' delivers — bytes normally, a STRING on an
   * encoding'd source, 1744's own shape — to `dest.write()` unchanged;
   * this tier's write() only accepts bytes, so ondata re-encodes a
   * STR-kind chunk back rather than assuming BYTES). */
  dynT: () => number;
  /** dyn.ts's raw `$str` type index (mirrors `bytesStructType`/
   * `bytesBufType` above — a type a `refCast` needs by number, not the
   * `strRef()` ValType wrapper). */
  strType: () => number;
  /** dyn.ts's `bytesPayloadBytes` — from a `$dyn` the caller pushes
   * (already known BYTES-kind), the raw `$bytes` ref (unwraps the
   * `{bytes, isBuffer}` box `pushBytesPayload` builds, the inverse
   * operation). */
  bytesPayloadBytes: (c: Code, pushDyn: (c: Code) => void) => void;
  /** events.ts's/dyn.ts's uniform listener-thunk call-glue type index —
   * `(clos: eq, args: dynArr) -> dyn` — needed raw to DECLARE pipe()'s
   * own three internal thunks with the exact type `entryAppend`'s THUNK
   * parameter expects. */
  thunkSig: () => number;
  /** LAYER 6 (P2-1 fix round, bounded diagnosis): events.ts's DEDICATED
   * 'error'-bucket call-glue type index — `(clos: eq, err: errRef) ->
   * void`, a real error reference directly, no dyn box at all (events.ts
   * own "one exception"). `errDispatch()`/`hasErrorListeners()` read
   * ONLY `reg.errBucket` (confirmed by reading both bodies) — a listener
   * registered through the GENERAL family (`entryAppend`, `thunkSig()`)
   * lands in `reg.head` instead, under a bucket literally named "error",
   * structurally invisible to both. `pipelineErrThunk` MUST be declared
   * against THIS signature, not `thunkSig()`, to be reachable at all. */
  errThunkSig: () => number;
  /** events.ts's `(root, clos, thunk, once, prepend) -> void` — the
   * err-bucket's OWN registration door (mirrors `entryAppend` for the
   * general family, no `name` param since the bucket IS "error" by
   * definition, no `orig` param since internal registrations have no
   * wrapped-listener identity to track — events.ts's own errEntryAppend
   * header). `pipelineErrThunk`'s own registration (pipelineRegister
   * OneStage) MUST call THIS, not `entryAppend`, or `errDispatch` never
   * sees it (this dep's own header has the full measured story). */
  errEntryAppend: () => number;

  /* ── STAGE C dyn-adapter phase: pending-check hardening ────────────── */

  /** %w.err.reportUncaught() — emitter.ts's shared bare-uncaught-throw
   * reporter (S007's trap-report bridge), exposed as a raw function
   * index (matching timers.ts's/nexttick.ts's own `reportUncaught`
   * convention) for the ONE call site here that needs a genuine
   * immediate crash rather than a caught-and-routed error:
   * `doWriteCore`'s `_write`/`_writev` dispatch. Node's own `doWrite`
   * (internal/streams/writable.js) wraps neither in a try/catch —
   * measured via d13-sync-throw-write.cjs, a synchronous throw crashes
   * real Node immediately, before any later script statement runs.
   * Call after confirming `excKind()` is nonzero:
   * `globalGet(excKind()); ifVoid(); call(reportUncaught()); end();` —
   * never returns. `_final`/`_destroy` do NOT use this — Node wraps
   * those internally and routes a thrown error through the ordinary
   * async completion-callback landing instead (maybeFinishCore/
   * buildDestroyErrCore's own `tryCatchAsError`-based fixes, measured
   * separately via d13b/d13c — the sibling rule's own lesson: don't
   * assume symmetry). */
  reportUncaught: () => number;

  /* ── STAGE D P2 additions: pipeline()'s FIN_KIND_DYN final callback ── */

  /** dyn.ts's `(fn: dyn, args: dynArr, name: str) -> dyn` call machinery
   * — the SAME path `emitFnEvalCall`'s bare `f(...)` form and the
   * `callFn` jsOp both dispatch through. Needed for `firePipelineFinal`'s
   * DYN branch: 1814's `wrap(fn)` helper returns a value the frontend
   * cannot pin to a static func type, so `pipeline`'s lowering routes
   * through `stream.pipelineDyn` and the final callback has to be called
   * THIS way rather than through a typed thunk. A pending exception left
   * behind (the callee itself throwing) is NOT checked here — the SAME
   * "caller already checks" contract `jsonParse` documents above:
   * `firePipelineFinal` only ever runs via `dispatchPipelineFinal`,
   * itself always reached through `enqueueRaw()`, so nexttick.ts's own
   * drain loop checks `excKind()` right after this function returns. */
  callFn: () => number;
  /** dyn.ts's `(e: errRef nullable) -> dyn` — boxes a real Error value
   * into the SAME dyn OBJ box `String(e)`/JSON.stringify would see
   * (S021's enumerable-name/message/code shape), for the DYN callback's
   * first argument. Live-measured (`node -e ...pipeline(...)`, both the
   * success and mid-stream-error shapes): Node calls the pipeline
   * callback with TWO arguments always — `(err, val)` — and `val` is
   * observed `undefined` in every shape this tier's corpus exercises
   * (including an async-generator final stage that itself returns a
   * value), so the DYN dispatch's second element is a fixed
   * `undefinedDynGlobal`, never threaded from anywhere. */
  fromError: () => number;
  /** dyn.ts's `(d: dyn) -> errRef nullable` — the REVERSE of `fromError`,
   * for pipeline's own internal 'error' listener thunk: `errDispatch()`'s
   * emit path boxes the stage's real RS_ERROR through `fromError()`
   * before any registered thunk sees it (dyn.ts's own header — every
   * real errRef crossing into dyn is minted through that ONE box), so
   * unboxing back through the SAME cache scan recovers the identical
   * instance `pipelineFinishImpl` needs (an errRef, not a dyn box). */
  toError: () => number;
}

// $bytes's field indices (typedarrays.ts's own private layout, mirrored
// here rather than exported cross-file — see StreamDeps.bytesStructType).
const BYTES_STORAGE = 0;
const BYTES_OFF = 1;
const BYTES_LEN = 2;

// pipeClosT's own field indices (STAGE C PASS 2 — pipe()'s shared
// src/dst closure shape, see its own header).
const PIPE_SRC = 0;
const PIPE_DST = 1;

export class StreamBuilder {
  private readonly fns = new Map<string, number>();
  private stateTField: number | null = null;
  private chunkTField: number | null = null;
  private wReqTField: number | null = null;
  private tickTField: number | null = null;
  private readThunkSigField: number | null = null;
  private writeThunkSigField: number | null = null;
  private finalThunkSigField: number | null = null;
  private destroyThunkSigField: number | null = null;
  private finEntryTField: number | null = null;
  private voidClosFnField: number | null = null;
  private pipeClosTField: number | null = null;
  private tickQueue: { head: number; tail: number } | null = null;
  private pipelineCtxTField: number | null = null;
  private pipelineStagesArrTField: number | null = null;
  private pipelineTickTField: number | null = null;
  private pipelineTickQueue: { head: number; tail: number } | null = null;
  private writeCompletionTField: number | null = null;
  private writeCompletionQueueField: { head: number; tail: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: StreamDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  private cachedRecursive(name: string, declare: () => number, build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = declare();
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  /** `readThunkSig` — the underscore `_read`'s own uniform call-glue:
   * `(clos: eq, this: root, size: f64) -> void`. Compiler-generated glue
   * calling a stored slot (no dyn box — events.ts's errThunkSig precedent
   * for a non-JS-listener signature), but UNLIKE errThunkFor's listener
   * thunks, `_read`'s closure comes from lower-stream.ts's
   * streamMethodWrapper, which lifts the override into a `(this,
   * ...prefix) => ret` closure — the receiver is a REAL declared
   * parameter of the closure's own signature, not captured in its
   * environment, so the thunk must carry it across explicitly (the
   * adapter downcasts `this` from the generic %Readable root to the
   * declaring class, per-signature — emitter.ts's `readThunkFor`). */
  readThunkSig(): number {
    if (this.readThunkSigField === null) {
      const rootRef = this.deps.rootRef();
      this.readThunkSigField = this.mb.funcType([EQ_REF, rootRef, F64], []);
    }
    return this.readThunkSigField;
  }

  /** `writeThunkSig` — `_write`'s glue: `(clos, this, chunk: bytes,
   * encoding: str, wreq: $wReq) -> void`. The wreq (NOT a pre-built
   * callback closure) is the last argument: emitter.ts's `writeThunkFor`
   * adapter — built once per DECLARED callback signature, exactly like
   * `readThunkFor` refCasts `this` to the declaring class — is the one
   * place that knows the user's declared callback type, so IT builds the
   * matching done-closure (env: this wreq) and calls the user's `_write`
   * with it; this file only ever needs to hand over which request is in
   * flight. The encoding is always the literal "buffer" (decodeStrings'
   * real default — 1688's own comment: chunks are Buffers, so Node's
   * true encoding argument is always that one string) — passed as a
   * plain interned string rather than threaded per-call, since it never
   * varies on this tier (no `decodeStrings: false` support). Every
   * `_write` override may declare any PREFIX of (chunk, encoding, cb) —
   * the option-callback rule (readThunkFor's own precedent). */
  writeThunkSig(): number {
    if (this.writeThunkSigField === null) {
      const rootRef = this.deps.rootRef();
      this.writeThunkSigField = this.mb.funcType(
        [EQ_REF, rootRef, this.deps.bytesRef(), this.deps.strRef(), this.wReqRef()],
        [],
      );
    }
    return this.writeThunkSigField;
  }

  /** `finalThunkSig` — `_final`'s glue: `(clos, this) -> void`. No wreq:
   * `_final` has no per-request identity, and its done-closure's env is
   * just `this` (already a parameter) — `finalThunkFor` (emitter.ts,
   * mirroring `writeThunkFor`) builds it directly. May declare a 0-arg
   * prefix (no `this`-only form exists for option callbacks — every
   * stream callback's OWN first bound parameter is always `this` itself,
   * per lower-stream.ts's uniform shape; the declared-prefix axis is the
   * completion callback alone here, which is never itself a DECLARED
   * parameter of `finalThunkSig` — it is built fresh by the adapter). */
  finalThunkSig(): number {
    if (this.finalThunkSigField === null) {
      const rootRef = this.deps.rootRef();
      this.finalThunkSigField = this.mb.funcType([EQ_REF, rootRef], []);
    }
    return this.finalThunkSigField;
  }

  /** `destroyThunkSig` — `_destroy(err, callback)`'s glue: `(clos, this,
   * err: errRef) -> void`. Mirrors `finalThunkSig` — no wreq (destroy has
   * no per-request identity either), env is just `this`. */
  destroyThunkSig(): number {
    if (this.destroyThunkSigField === null) {
      const rootRef = this.deps.rootRef();
      this.destroyThunkSigField = this.mb.funcType([EQ_REF, rootRef, this.deps.errRef()], []);
    }
    return this.destroyThunkSigField;
  }

  chunkT(): number {
    if (this.chunkTField !== null) return this.chunkTField;
    // Every OTHER type the fields need is resolved BEFORE the call
    // (module.ts's selfStructType contract: `make` must not intern
    // anything, since the reserved index would move under it).
    const bytesRef = this.deps.bytesRef();
    this.chunkTField = this.mb.selfStructType("%w.rs.chunk", (self) => [
      { storage: bytesRef, mutable: false }, // CHUNK_BYTES
      { storage: I32, mutable: true }, // CHUNK_OFF
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // CHUNK_NEXT
    ]);
    return this.chunkTField;
  }

  chunkRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.chunkT() };
  }

  /** `$wReq`'s struct type — one queued write-request node (WREQ_* field
   * indices above). `WREQ_CB_CLOS` is the user's own `write(chunk, cb)`
   * callback, nullable (a callback-less `write(chunk)` is common) —
   * exactly `this.deps.voidClos().clos`, which needs NO adapter/thunk
   * beside it: lower-stream.ts fences any write/end callback declaring
   * the error parameter ("write completion callbacks taking the error
   * argument" has no lowering — `() => void` is the only supported
   * shape), so calling one back is a direct `structGet(clos, code);
   * callRef` against the ONE shared zero-arg signature, no per-signature
   * adapter needed (unlike RS_READ_CLOS/RS_READ_THUNK's split, which
   * exists because `_read`'s declared prefix genuinely varies). */
  wReqT(): number {
    if (this.wReqTField !== null) return this.wReqTField;
    const bytesRef = this.deps.bytesRef();
    const cbRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
    this.wReqTField = this.mb.selfStructType("%w.ws.wreq", (self) => [
      { storage: bytesRef, mutable: false }, // WREQ_BYTES
      { storage: cbRef, mutable: false }, // WREQ_CB_CLOS
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // WREQ_NEXT
    ]);
    return this.wReqTField;
  }

  wReqRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.wReqT() };
  }

  stateT(): number {
    if (this.stateTField !== null) return this.stateTField;
    const readThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.readThunkSig() };
    const writeThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.writeThunkSig() };
    const finalThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.finalThunkSig() };
    const destroyThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.destroyThunkSig() };
    this.stateTField = this.mb.structType([
      { storage: F64, mutable: true }, // RS_HWM
      { storage: F64, mutable: true }, // RS_LENGTH
      { storage: this.chunkRef(), mutable: true }, // RS_HEAD
      { storage: this.chunkRef(), mutable: true }, // RS_TAIL
      { storage: I32, mutable: true }, // RS_FLOWING
      { storage: I32, mutable: true }, // RS_READING
      { storage: I32, mutable: true }, // RS_SYNC
      { storage: I32, mutable: true }, // RS_ENDED
      { storage: I32, mutable: true }, // RS_END_EMITTED
      { storage: I32, mutable: true }, // RS_END_SCHEDULED
      { storage: I32, mutable: true }, // RS_NEED_READABLE
      { storage: I32, mutable: true }, // RS_EMITTED_READABLE
      { storage: I32, mutable: true }, // RS_RESUME_SCHEDULED
      { storage: I32, mutable: true }, // RS_DESTROYED
      { storage: this.deps.errRef(), mutable: true }, // RS_ERROR
      { storage: I32, mutable: true }, // RS_EMIT_CLOSE
      { storage: I32, mutable: true }, // RS_AUTO_DESTROY
      { storage: EQ_REF, mutable: true }, // RS_READ_CLOS
      { storage: readThunkRef, mutable: true }, // RS_READ_THUNK
      { storage: I32, mutable: true }, // RS_READABLE_LISTENING
      { storage: I32, mutable: true }, // RS_READING_MORE
      { storage: I32, mutable: true }, // RS_ENCODING
      { storage: this.deps.bytesRef(), mutable: true }, // RS_DEC_PENDING
      { storage: I32, mutable: true }, // RS_PUSH_ENC
      { storage: this.deps.promRef(), mutable: true }, // RS_WAITER
      { storage: I32, mutable: true }, // RS_CONSUMER_KIND
      { storage: this.deps.promRef(), mutable: true }, // RS_CONSUMER_PROMISE
      { storage: this.deps.bytesRef(), mutable: true }, // RS_CONSUMER_ACC
      { storage: I32, mutable: true }, // RS_OBJECT_MODE
      { storage: I32, mutable: true }, // RS_CHECKING_WAITER
      { storage: I32, mutable: true }, // RS_CLOSE_EMITTED
      { storage: F64, mutable: true }, // WS_HWM
      { storage: F64, mutable: true }, // WS_LENGTH
      { storage: this.wReqRef(), mutable: true }, // WS_HEAD
      { storage: this.wReqRef(), mutable: true }, // WS_TAIL
      { storage: F64, mutable: true }, // WS_CORKED
      { storage: I32, mutable: true }, // WS_WRITING
      { storage: I32, mutable: true }, // WS_SYNC
      { storage: I32, mutable: true }, // WS_ENDING
      { storage: I32, mutable: true }, // WS_ENDED
      { storage: I32, mutable: true }, // WS_FINISHED
      { storage: I32, mutable: true }, // WS_NEED_DRAIN
      { storage: I32, mutable: true }, // WS_PREFINISHED
      { storage: EQ_REF, mutable: true }, // WS_WRITE_CLOS
      { storage: writeThunkRef, mutable: true }, // WS_WRITE_THUNK
      { storage: EQ_REF, mutable: true }, // WS_FINAL_CLOS
      { storage: finalThunkRef, mutable: true }, // WS_FINAL_THUNK
      { storage: { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }, mutable: true }, // WS_END_CLOS
      { storage: EQ_REF, mutable: true }, // RS_DESTROY_CLOS
      { storage: destroyThunkRef, mutable: true }, // RS_DESTROY_THUNK
      { storage: this.wReqRef(), mutable: true }, // WS_DISCARDED
      { storage: I32, mutable: true }, // WS_DESTROY_SYNC
      { storage: this.deps.rootRef(), mutable: true }, // RS_PIPE_DEST
      { storage: EQ_REF, mutable: true }, // RS_PIPE_ONDATA
      { storage: EQ_REF, mutable: true }, // RS_PIPE_ONDRAIN
      { storage: EQ_REF, mutable: true }, // RS_PIPE_ONEND
      { storage: I32, mutable: true }, // WS_ALLOW_HALF_OPEN
      { storage: I32, mutable: true }, // WS_DUPLEX_SHAPED
      { storage: I32, mutable: true }, // RS_SIDES
      { storage: this.finEntryRef(), mutable: true }, // FIN_HEAD
      { storage: I32, mutable: true }, // WS_SYNC_ERRORED
      { storage: I32, mutable: true }, // RS_ERROR_ABORT_SILENT
    ]);
    return this.stateTField;
  }

  stateRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.stateT() };
  }

  private tickT(): number {
    if (this.tickTField !== null) return this.tickTField;
    const rootRef = this.deps.rootRef();
    this.tickTField = this.mb.selfStructType("%w.rs.tick", (self) => [
      { storage: rootRef, mutable: false }, // RT_ROOT
      { storage: I32, mutable: false }, // RT_OP
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // RT_NEXT
    ]);
    return this.tickTField;
  }

  private tickRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.tickT() };
  }

  /** STAGE D `$w.rs.finEntry`'s field indices — one `finished()`/`eos()`
   * watcher list node (FIN_HEAD's own header has the full mechanism
   * story). THUNK reuses `destroyThunkSig()`'s ABI verbatim — `(clos: eq,
   * this: root, err: errRef|null) -> void` — Node's own eos() callback
   * shape (a single nullable-error argument, bound to the stream) is
   * exactly `_destroy(err, cb)`'s completion-callback shape already
   * built here; a per-closure-type adapter thunk (`finThunkFor`,
   * emitter.ts, mirroring `destroyThunkFor`'s own template) is what
   * actually calls the user's specific typed closure through it. */
  private finEntryT(): number {
    if (this.finEntryTField !== null) return this.finEntryTField;
    // selfStructType's own contract (chunkT's header, above): every OTHER
    // type a field needs must resolve BEFORE the call, since `make`
    // itself must not intern anything (the reserved index would move).
    const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.destroyThunkSig() };
    this.finEntryTField = this.mb.selfStructType("%w.rs.finEntry", (self) => [
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // FE_NEXT
      { storage: I32, mutable: false }, // FE_KIND — FIN_KIND_CB/DYN/PROMISE/PIPELINE
      { storage: EQ_REF, mutable: false }, // FE_CLOS — closure (typed or dyn), promise ref, or pipeline ctx, per KIND
      { storage: thunkRef, mutable: false }, // FE_THUNK — only used for FIN_KIND_CB
      { storage: I32, mutable: false }, // FE_ROLE — only used for FIN_KIND_PIPELINE (FIN_SIDE_R/W/RW)
    ]);
    return this.finEntryTField;
  }

  private finEntryRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.finEntryT() };
  }

  /** STAGE D P2 `$w.rs.pipelineStages` — a fixed-length GC array of stage
   * roots, sized N at construction (`array.new_fixed`, N always a
   * compile-time literal per lower-stream.ts's own `f64Lit(streams.
   * length, loc)` convention — no runtime-variable sizing needed).
   * Immutable elements: the stage list never changes after `pipeline()`
   * itself returns. PUBLIC (not `private`, unlike this file's other type
   * getters): emitter.ts's own pipeline dispatch case builds this array
   * ITSELF, one raw `array.new_fixed` after walking each stage argument
   * expression inline (the SAME reason `dynArrBufType`/`dynArrStructType`
   * flow the OPPOSITE direction, through `StreamDeps` — here emitter.ts
   * is the one doing the low-level Code emission, not this file). */
  pipelineStagesArrT(): number {
    if (this.pipelineStagesArrTField !== null) return this.pipelineStagesArrTField;
    this.pipelineStagesArrTField = this.mb.arrayType(this.deps.rootRef(), false);
    return this.pipelineStagesArrTField;
  }

  private pipelineStagesArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pipelineStagesArrT() };
  }

  /** STAGE D P2 `$w.rs.pipelineCtx` — one per `pipeline()`/`pipelineDyn`/
   * `sp.pipeline` call (PCTX_* field indices, above, have the full
   * mechanism story). PUBLIC for the same reason `pipelineStagesArrT` is:
   * emitter.ts's dispatch case `structNew`s this directly, pushing all 9
   * fields itself in order (N, CLOSED_COUNT=0, ERRORSET=0,
   * ERROR_IS_PLACEHOLDER=0, ERROR=null, FINAL_KIND, FINAL_CLOS,
   * FINAL_THUNK, STAGES) — the three FINAL_* fields differ per call
   * shape (stream.pipeline/pipelineDyn/sp.pipeline), which only the
   * dispatch case itself, not a shared builder here, has the context to
   * assemble. */
  pipelineCtxT(): number {
    if (this.pipelineCtxTField !== null) return this.pipelineCtxTField;
    // Resolve dependent types first — selfStructType/structType's own
    // contract (finEntryT's own header, above).
    const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.destroyThunkSig() };
    const stagesRef = this.pipelineStagesArrRef();
    this.pipelineCtxTField = this.mb.structType([
      { storage: I32, mutable: false }, // PCTX_N
      { storage: I32, mutable: true }, // PCTX_CLOSED_COUNT
      { storage: I32, mutable: true }, // PCTX_ERRORSET
      { storage: I32, mutable: true }, // PCTX_ERROR_IS_PLACEHOLDER
      { storage: this.deps.errRef(), mutable: true }, // PCTX_ERROR
      { storage: I32, mutable: false }, // PCTX_FINAL_KIND
      { storage: EQ_REF, mutable: false }, // PCTX_FINAL_CLOS
      { storage: thunkRef, mutable: false }, // PCTX_FINAL_THUNK
      { storage: stagesRef, mutable: false }, // PCTX_STAGES
    ]);
    return this.pipelineCtxTField;
  }

  /** PUBLIC — emitter.ts's dispatch case needs this ValType both to
   * declare its own scratch local for the freshly-built ctx and to know
   * `destroyThunkSig()`'s companion thunk-ref shape for PCTX_FINAL_THUNK
   * (the CB path's `finThunkFor`-built adapter). */
  pipelineCtxRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pipelineCtxT() };
  }

  /* ── pipeline's own private final-callback FIFO (STAGE D P2) ────────── */

  private pipelineTickT(): number {
    if (this.pipelineTickTField !== null) return this.pipelineTickTField;
    const ctxRef = this.pipelineCtxRef();
    this.pipelineTickTField = this.mb.selfStructType("%w.rs.pipelineTick", (self) => [
      { storage: ctxRef, mutable: false }, // PT_CTX
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // PT_NEXT
    ]);
    return this.pipelineTickTField;
  }

  private pipelineTickRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pipelineTickT() };
  }

  private pipelineQ(): { head: number; tail: number } {
    if (this.pipelineTickQueue === null) {
      const t = this.pipelineTickRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0); // ref.null $w.rs.pipelineTick
        w.sleb(this.pipelineTickT());
      };
      this.pipelineTickQueue = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.pipelineTickQueue;
  }

  /** `(ctx) -> void` — schedules ctx's final callback ONE tick from now
   * (probe12's own extra hop), via the SAME `enqueueRaw()`/nexttick.ts
   * seam `scheduleTick()` uses, so it interleaves correctly against
   * user nextTicks and every OTHER deferred stream tick. */
  private schedulePipelineFinal(): number {
    return this.cachedRecursive(
      "schedulePipelineFinal",
      () => this.mb.declareFunc(this.mb.funcType([this.pipelineCtxRef()], []), "%w.rs.schedulePipelineFinal"),
      (idx) => {
        const q = this.pipelineQ();
        const c = new Code();
        const CTX = 0, N = 1;
        c.localGet(CTX);
        c.refNull(this.pipelineTickT());
        c.structNew(this.pipelineTickT());
        c.localSet(N);
        c.globalGet(q.tail);
        c.refIsNull();
        c.ifVoid();
        c.localGet(N);
        c.globalSet(q.head);
        c.else_();
        c.globalGet(q.tail);
        c.localGet(N);
        c.structSet(this.pipelineTickT(), PT_NEXT);
        c.end();
        c.localGet(N);
        c.globalSet(q.tail);
        this.mb.declareFuncRef(this.dispatchPipelineFinal());
        c.refFunc(this.dispatchPipelineFinal());
        c.call(this.deps.enqueueRaw());
        this.mb.setBody(idx, [this.pipelineTickRef()], c.bytes());
      },
    );
  }

  /** `() -> ()` — the raw marker's target: pops ONE ctx off the queue
   * and fires its final callback. Only one kind of work item ever rides
   * this queue, so there is no op-code dispatch at all (PT_NEXT's own
   * header explains why this queue is not shared with $rTick). */
  private dispatchPipelineFinal(): number {
    return this.cachedRecursive(
      "dispatchPipelineFinal",
      () => this.mb.declareFunc(this.deps.rawFnType(), "%w.rs.dispatchPipelineFinal"),
      (idx) => {
        const q = this.pipelineQ();
        const c = new Code();
        const N = 0, CTX = 1;
        c.globalGet(q.head);
        c.localSet(N);
        c.localGet(N);
        c.structGet(this.pipelineTickT(), PT_NEXT);
        c.globalSet(q.head);
        c.globalGet(q.head);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.pipelineTickT());
        c.globalSet(q.tail);
        c.end();
        c.localGet(N);
        c.refNull(this.pipelineTickT());
        c.structSet(this.pipelineTickT(), PT_NEXT);
        c.localGet(N);
        c.structGet(this.pipelineTickT(), PT_CTX);
        c.localSet(CTX);
        c.localGet(CTX);
        c.call(this.firePipelineFinal());
        this.mb.setBody(idx, [this.pipelineTickRef(), this.pipelineCtxRef()], c.bytes());
      },
    );
  }

  /* ── state lookup ──────────────────────────────────────────────────── */

  /** `(root) -> state` — lazily allocates the state struct with every
   * scalar at its zero/unset default and stores it back into the root's
   * own stream-state field (mirrors events.ts's regEnsure). Construction
   * (readable.new/init) calls this THEN immediately overwrites hwm/auto-
   * destroy/emitClose/the read closure — this function only guarantees a
   * non-null state exists, exactly like regEnsure's own contract. */
  stateEnsure(): number {
    return this.cached("stateEnsure", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.stateRef()]), "%w.rs.stateEnsure");
      const c = new Code();
      const R = 0, N = 1;
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), STREAM_STATE);
      c.refIsNull();
      c.ifVoid();
      c.f64Const(65536); // hwm default (overwritten by construction; Node's real non-Windows default)
      c.f64Const(0); // length
      c.refNull(this.chunkT()); // head
      c.refNull(this.chunkT()); // tail
      c.i32Const(-1); // flowing
      c.i32Const(0); // reading
      c.i32Const(1); // sync — Node's real default: TRUE from construction (RS_SYNC's own header)
      c.i32Const(0); // ended
      c.i32Const(0); // end_emitted
      c.i32Const(0); // end_scheduled
      c.i32Const(0); // need_readable
      c.i32Const(0); // emitted_readable
      c.i32Const(0); // resume_scheduled
      c.i32Const(0); // destroyed
      c.refNull(this.errType()); // error
      c.i32Const(1); // emit_close default (overwritten by construction)
      c.i32Const(1); // auto_destroy default (overwritten by construction)
      c.refNull(EQ_HEAP); // read_clos
      c.refNull(this.readThunkSig()); // read_thunk
      c.i32Const(0); // readable_listening
      c.i32Const(0); // reading_more
      c.i32Const(0); // encoding (off)
      c.refNull(this.deps.bytesStructType()); // dec_pending
      c.i32Const(0); // push_enc (utf8)
      c.refNull(this.promType()); // waiter
      c.i32Const(0); // consumer_kind
      c.refNull(this.promType()); // consumer_promise
      c.refNull(this.deps.bytesStructType()); // consumer_acc
      c.i32Const(0); // object_mode
      c.i32Const(0); // checking_waiter
      c.i32Const(0); // close_emitted
      c.f64Const(65536); // ws_hwm default (overwritten by construction)
      c.f64Const(0); // ws_length
      c.refNull(this.wReqT()); // ws_head
      c.refNull(this.wReqT()); // ws_tail
      c.f64Const(0); // ws_corked
      c.i32Const(0); // ws_writing
      c.i32Const(1); // ws_sync — Node's real default: true from construction (WS_SYNC mirrors RS_SYNC)
      c.i32Const(0); // ws_ending
      c.i32Const(0); // ws_ended
      c.i32Const(0); // ws_finished
      c.i32Const(0); // ws_need_drain
      c.i32Const(0); // ws_prefinished
      c.refNull(EQ_HEAP); // ws_write_clos
      c.refNull(this.writeThunkSig()); // ws_write_thunk
      c.refNull(EQ_HEAP); // ws_final_clos
      c.refNull(this.finalThunkSig()); // ws_final_thunk
      c.refNull(this.deps.voidClos().clos); // ws_end_clos
      c.refNull(EQ_HEAP); // rs_destroy_clos
      c.refNull(this.destroyThunkSig()); // rs_destroy_thunk
      c.refNull(this.wReqT()); // ws_discarded
      c.i32Const(0); // ws_destroy_sync
      c.refNull(this.deps.rootStruct()); // rs_pipe_dest
      c.refNull(EQ_HEAP); // rs_pipe_ondata
      c.refNull(EQ_HEAP); // rs_pipe_ondrain
      c.refNull(EQ_HEAP); // rs_pipe_onend
      c.i32Const(1); // ws_allow_half_open — Node's real default: true (overwritten by construction)
      c.i32Const(0); // ws_duplex_shaped — default false (overwritten by construction, duplex/transform/passthrough only)
      c.i32Const(FIN_SIDE_UNSET); // rs_sides — the sentinel (FIN_SIDE_UNSET's own header): every real construction path MUST overwrite this explicitly; finComputeErr refuses by name if it ever observes UNSET
      c.refNull(this.finEntryT()); // fin_head — the finished()/eos() watcher list, empty at construction
      c.i32Const(0); // ws_sync_errored — FIX ROUND (P2-1): reset false at construction; write()'s own entry resets it again per-call (its own header)
      c.i32Const(0); // rs_error_abort_silent — STAGE D P4: reset false at construction; destroyAbortedCore sets it, opError clears it (RS_ERROR_ABORT_SILENT's own header)
      c.structNew(this.stateT());
      c.localSet(N);
      c.localGet(R);
      c.localGet(N);
      c.structSet(this.deps.rootStruct(), STREAM_STATE);
      c.end();
      c.localGet(R);
      c.structGet(this.deps.rootStruct(), STREAM_STATE);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  private errType(): number {
    const ref = this.deps.errRef();
    if (ref.kind !== "ref") throw new Error("wasm emitter bug: errRef is not a ref type");
    return ref.typeIndex;
  }

  private promType(): number {
    const ref = this.deps.promRef();
    if (ref.kind !== "ref") throw new Error("wasm emitter bug: promRef is not a ref type");
    return ref.typeIndex;
  }

  /* ── the private tick FIFO (scr_st_tick / scr_stream_dispatch_one) ──── */

  private q(): { head: number; tail: number } {
    if (this.tickQueue === null) {
      const t = this.tickRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0); // ref.null $rTick
        w.sleb(this.tickT());
      };
      this.tickQueue = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.tickQueue;
  }

  /** `(root, op: i32) -> void` — schedules ONE deferred stream emission:
   * appends a node to this file's own private list, then posts one bare
   * marker onto nexttick.ts's queue (the stage-0 seam) so it dispatches
   * in true FIFO order against user nextTicks (2627's pin). Callers own
   * their own idempotency guards (end_scheduled, emitted_readable, etc)
   * — this function always enqueues unconditionally. */
  private scheduleTick(): number {
    // cachedRecursive, NOT plain cached: this function's own body reaches
    // BACK into itself through a real cycle (scheduleTick -> dispatchOne
    // -> opResume -> flow -> readCore -> endReadableCore ->
    // scheduleTick again) — events.ts's emitDispatch/fireMetaHelper
    // header explains the exact hazard (a plain `cached` only records the
    // index once `build` fully RETURNS, so the reentrant call during that
    // same build recurses into building a SECOND copy forever). Reserving
    // the index before building the body, as this does, is what breaks
    // the cycle.
    return this.cachedRecursive(
      "scheduleTick",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), I32], []), "%w.rs.scheduleTick"),
      (idx) => {
        const q = this.q();
        const c = new Code();
        const ROOT = 0, OP = 1, N = 2;
        c.localGet(ROOT);
        c.localGet(OP);
        c.refNull(this.tickT());
        c.structNew(this.tickT());
        c.localSet(N);
        c.globalGet(q.tail);
        c.refIsNull();
        c.ifVoid();
        c.localGet(N);
        c.globalSet(q.head);
        c.else_();
        c.globalGet(q.tail);
        c.localGet(N);
        c.structSet(this.tickT(), RT_NEXT);
        c.end();
        c.localGet(N);
        c.globalSet(q.tail);
        // ref.func requires the target in the module's declared-functions
        // element segment (module.ts's declareFuncRef) — dispatchOne is
        // taken BY REFERENCE here (not called directly), so it needs the
        // explicit declaration every plain `call` site gets for free.
        this.mb.declareFuncRef(this.dispatchOne());
        c.refFunc(this.dispatchOne());
        c.call(this.deps.enqueueRaw());
        this.mb.setBody(idx, [this.tickRef()], c.bytes());
      },
    );
  }

  /** `() -> ()` — the raw marker's target (nexttick.ts's bare-funcref
   * seam): pops ONE node off this file's private list and dispatches by
   * op code. nexttick.ts's drain() already checks the exception cell
   * after calling this and traps if it's set — an uncaught 'error'
   * inside `opError` needs no unwind logic of its own here. */
  private dispatchOne(): number {
    return this.cachedRecursive(
      "dispatchOne",
      () => this.mb.declareFunc(this.deps.rawFnType(), "%w.rs.dispatchOne"),
      (idx) => {
        const q = this.q();
        const c = new Code();
        const N = 0, ROOT = 1, OP = 2;
        c.globalGet(q.head);
        c.localSet(N);
        c.localGet(N);
        c.structGet(this.tickT(), RT_NEXT);
        c.globalSet(q.head);
        c.globalGet(q.head);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.tickT());
        c.globalSet(q.tail);
        c.end();
        c.localGet(N);
        c.refNull(this.tickT());
        c.structSet(this.tickT(), RT_NEXT);
        c.localGet(N);
        c.structGet(this.tickT(), RT_ROOT);
        c.localSet(ROOT);
        c.localGet(N);
        c.structGet(this.tickT(), RT_OP);
        c.localSet(OP);
        // NO "clear sync here" step — that was this file's own invented
        // one-time latch (the gate-round B2 finding). `sync` is now
        // cleared ONLY by `callRead`'s own per-_read-call bracket,
        // matching Node's real `state.sync` exactly (RS_SYNC's header).
        c.localGet(OP);
        c.i32Const(OP_READABLE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opReadable());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_RESUME);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opResume());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_END);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opEnd());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_ERROR);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opError());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_CLOSE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opClose());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_READMORE);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opReadMore());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_DRAIN);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opDrain());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_FINISH);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opFinish());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_FIRE_DISCARDED);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opFireDiscarded());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_AUTO_END);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opAutoEnd());
        c.else_();
        c.localGet(OP);
        c.i32Const(OP_FIN);
        c.i32Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.opFin());
        c.else_();
        // OP_PRIME_READ, exhaustive: the op codes are this file's own
        // closed enum, never a runtime-supplied value.
        c.localGet(ROOT);
        c.call(this.opPrimeRead());
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        c.end();
        this.mb.setBody(idx, [this.tickRef(), this.deps.rootRef(), I32], c.bytes());
      },
    );
  }

  /* ── the chunk list ────────────────────────────────────────────────── */

  /** `(state, bytes, front: i32) -> void` — appends (or, if `front`,
   * prepends) one chunk node and adds its length to `state.length`
   * (scr_stream_rbuf_push, minus the ring-buffer representation — a
   * plain list here). */
  private appendChunk(): number {
    return this.cached("appendChunk", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.stateRef(), this.deps.bytesRef(), I32], []),
        "%w.rs.appendChunk",
      );
      const c = new Code();
      const ST = 0, BY = 1, FRONT = 2, N = 3;
      c.localGet(BY);
      c.i32Const(0);
      c.refNull(this.chunkT());
      c.structNew(this.chunkT());
      c.localSet(N);
      c.localGet(FRONT);
      c.ifVoid();
      c.localGet(N);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structSet(this.chunkT(), CHUNK_NEXT);
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_HEAD);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_TAIL);
      c.localGet(N);
      c.structSet(this.chunkT(), CHUNK_NEXT);
      c.end();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(BY);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.f64ConvertI32S();
      c.f64Add();
      c.structSet(this.stateT(), RS_LENGTH);
      this.mb.setBody(idx, [this.chunkRef()], c.bytes());
      return idx;
    });
  }

  /* ── PASS 2: the utf8 StringDecoder ───────────────────────────────────
   * scr_bytes.c's `scr_strdec_*` family, minus its f64-bit-packed pending
   * state (a real WasmGC `bytesRef` field holds 0-3 pending bytes
   * directly — no packing trick needed) and minus the decode/encode
   * PRIMITIVES themselves (typedarrays.ts's `toStrHelper('utf8')` /
   * `fromStrHelper('utf8')` already ARE `scr_bytes_decode_utf8`'s and
   * `scr_bytes_from_str`'s wasm ports, corpus-proven by Buffer.prototype.
   * toString/Buffer.from already — reused verbatim here, not
   * reimplemented). The one genuinely new algorithm is `utf8TailLen`:
   * Node's own `utf8CheckIncomplete`'s 3-byte lookback, ported from
   * scr_bytes.c's `scr_strdec_tail` byte-for-byte. */

  /** `(a, b) -> bytes` — a fresh copy of `a` followed by `b` (the
   * pending+chunk combine every decode step needs — takeFromChunks'
   * arrayCopy pattern, twice, over a freshly sized buffer). */
  private concatTwoBytes(): number {
    return this.cached("concatTwoBytes", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.deps.bytesRef(), this.deps.bytesRef()], [this.deps.bytesRef()]),
        "%w.rs.concatTwoBytes",
      );
      const c = new Code();
      const A = 0, B = 1, NA = 2, NB = 3, TOTAL = 4, OUT = 5;
      c.localGet(A);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localSet(NA);
      c.localGet(B);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localSet(NB);
      c.localGet(NA);
      c.localGet(NB);
      c.i32Add();
      c.localSet(TOTAL);
      c.localGet(TOTAL);
      c.arrayNewDefault(this.deps.bytesBufType());
      c.localSet(OUT);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(A);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(A);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(NA);
      c.arrayCopy(this.deps.bytesBufType(), this.deps.bytesBufType());
      c.localGet(OUT);
      c.localGet(NA);
      c.localGet(B);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(B);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(NB);
      c.arrayCopy(this.deps.bytesBufType(), this.deps.bytesBufType());
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(TOTAL);
      c.structNew(this.deps.bytesStructType());
      this.mb.setBody(idx, [I32, I32, I32, { kind: "ref", nullable: false, typeIndex: this.deps.bytesBufType() }], c.bytes());
      return idx;
    });
  }

  /** `(bytes) -> i32` — Node's real `utf8CheckIncomplete`, scr_bytes.c's
   * `scr_strdec_tail` ported verbatim: scans back up to 3 bytes; a
   * continuation byte (10xxxxxx) keeps walking; a LEAD byte needing N
   * total bytes (2/3/4, by its own high bits) that hasn't seen all N yet
   * holds back exactly the bytes seen so far; an ASCII byte, an invalid
   * lead, or 3 continuations with no lead found decode NOW (0 held). */
  private utf8TailLen(): number {
    return this.cached("utf8TailLen", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.bytesRef()], [I32]), "%w.rs.utf8TailLen");
      const c = new Code();
      const BY = 0, N = 1, SCAN = 2, BACK = 3, IDX = 4, B = 5, NEED = 6;
      c.localGet(BY);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localSet(N);
      c.localGet(N);
      c.i32Const(3);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(N);
      c.else_();
      c.i32Const(3);
      c.end();
      c.localSet(SCAN);
      c.i32Const(1);
      c.localSet(BACK);
      c.loop();
      c.localGet(BACK);
      c.localGet(SCAN);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(N);
      c.localGet(BACK);
      c.i32Sub();
      c.localSet(IDX);
      c.localGet(BY);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(BY);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(IDX);
      c.i32Add();
      c.arrayGetU(this.deps.bytesBufType());
      c.localSet(B);
      c.localGet(B);
      c.i32Const(0xc0);
      c.i32And();
      c.i32Const(0x80);
      c.i32Eq();
      c.ifVoid();
      c.localGet(BACK);
      c.i32Const(1);
      c.i32Add();
      c.localSet(BACK);
      // br 1, NOT br 0: this br sits one level inside the "is a
      // continuation byte" ifVoid, which is itself one level inside the
      // loop — depth 0 from here is the ifVoid's OWN end (just falls
      // through, does not restart the loop); depth 1 reaches the loop.
      // THE BUG (found via execution, not review): a bare `br(0)` here
      // silently exited the if instead of continuing the scan, so the
      // FIRST continuation byte encountered while walking backward fell
      // through into the lead-byte classification below and returned
      // early — invisible for a SINGLE pending byte (utf8TailLen's own
      // first iteration never takes this branch when the sole byte is a
      // lead, e.g. push()-ing a lone 0xF0), only surfacing once a SECOND
      // byte made the scan actually loop (2627's r2 split-emoji case).
      c.br(1);
      c.end();
      c.localGet(B);
      c.i32Const(0xe0);
      c.i32And();
      c.i32Const(0xc0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(2);
      c.localSet(NEED);
      c.else_();
      c.localGet(B);
      c.i32Const(0xf0);
      c.i32And();
      c.i32Const(0xe0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(3);
      c.localSet(NEED);
      c.else_();
      c.localGet(B);
      c.i32Const(0xf8);
      c.i32And();
      c.i32Const(0xf0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(4);
      c.localSet(NEED);
      c.else_();
      c.i32Const(0);
      c.return_();
      c.end();
      c.end();
      c.end();
      c.localGet(BACK);
      c.localGet(NEED);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(BACK);
      c.else_();
      c.i32Const(0);
      c.end();
      c.return_();
      c.end();
      c.unreachable(); // the loop only exits via return_
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** `(state, chunk) -> bytes` — one StringDecoder.write() step: combines
   * `state.RS_DEC_PENDING` with the new chunk, holds back an incomplete
   * trailing sequence (utf8TailLen), decodes the complete prefix, and
   * RE-ENCODES it back to utf8 bytes (so the caller's existing bytes-only
   * chunk-list machinery — appendChunk/takeFromChunks/emitDataFrom's
   * bytes-box path — needs no second representation; only emitDataFrom's
   * dyn-box CHOICE changes for encoded streams, decoding back to a string
   * at the very last step, never twice). Returns a real (possibly
   * zero-length) bytes value, never null — the caller tests `.length`.
   * Updates RS_DEC_PENDING as a side effect. */
  private decodeUtf8Step(): number {
    return this.cached("decodeUtf8Step", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.stateRef(), this.deps.bytesRef()], [this.deps.bytesRef()]),
        "%w.rs.decodeUtf8Step",
      );
      const c = new Code();
      const ST = 0, CHUNK = 1, COMBINED = 2, N = 3, TAIL = 4, COMPLETE = 5, RESULT = 6;
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DEC_PENDING);
      c.refIsNull();
      c.ifResult(this.deps.bytesRef());
      c.localGet(CHUNK);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DEC_PENDING);
      c.refAsNonNull();
      c.localGet(CHUNK);
      c.call(this.concatTwoBytes());
      c.end();
      c.localSet(COMBINED);
      c.localGet(COMBINED);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localSet(N);
      c.localGet(COMBINED);
      c.call(this.utf8TailLen());
      c.localSet(TAIL);
      c.localGet(N);
      c.localGet(TAIL);
      c.i32Sub();
      c.localSet(COMPLETE);
      c.localGet(COMPLETE);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(this.deps.bytesRef());
      c.localGet(COMBINED);
      c.f64Const(0);
      c.localGet(COMPLETE);
      c.f64ConvertI32S();
      c.call(this.deps.bytesSlice());
      c.call(this.deps.toStrUtf8());
      c.call(this.deps.bytesFromStrUtf8());
      c.else_();
      c.f64Const(0);
      c.call(this.deps.bytesNewLen());
      c.end();
      c.localSet(RESULT);
      c.localGet(ST);
      c.localGet(TAIL);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(this.deps.bytesRef());
      c.localGet(COMBINED);
      c.localGet(COMPLETE);
      c.f64ConvertI32S();
      c.localGet(N);
      c.f64ConvertI32S();
      c.call(this.deps.bytesSlice());
      c.else_();
      c.refNull(this.deps.bytesStructType());
      c.end();
      c.structSet(this.stateT(), RS_DEC_PENDING);
      c.localGet(RESULT);
      this.mb.setBody(idx, [this.deps.bytesRef(), I32, I32, I32, this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /** `(nibble: i32) -> void` — pushes ONE ASCII hex-digit char code
   * (lowercase, Node's own `hex` StringDecoder spelling) for a 0-15
   * value already on `nibbleLocal`. */
  private pushHexDigit(c: Code, nibbleLocal: number): void {
    c.localGet(nibbleLocal);
    c.i32Const(10);
    c.i32LtU();
    c.ifResult(I32);
    c.localGet(nibbleLocal);
    c.i32Const(0x30); // '0'
    c.i32Add();
    c.else_();
    c.localGet(nibbleLocal);
    c.i32Const(0x57); // 'a' - 10
    c.i32Add();
    c.end();
  }

  /** `(bytes) -> bytes` — STAGE C PASS 2, hex: every input byte becomes
   * exactly TWO output bytes (the ASCII hex digits), unconditionally —
   * Node's real `hex` StringDecoder has NO held-back/incomplete state at
   * all (measured directly: `write([0xde,0xad,0xbe])` — an ODD byte
   * count — answers the full "deadbe" immediately, no held nibble;
   * neither does splitting across multiple `write()` calls change this),
   * unlike `utf8`'s variable-width sequences — so this is a pure,
   * stateless bytes→bytes transform, no RS_DEC_PENDING analog needed.
   * The result is ASCII (trivially valid utf8), so emitDataFrom's
   * existing string-boxing path (`toStrUtf8`) decodes it back to a JS
   * string correctly with no changes there. */
  private hexEncodeStep(): number {
    return this.cached("hexEncodeStep", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.bytesRef()], [this.deps.bytesRef()]), "%w.rs.hexEncode");
      const c = new Code();
      const IN = 0, N = 1, OUT = 2, I = 3, B = 4, HI = 5, LO = 6;
      c.localGet(IN);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localSet(N);
      c.localGet(N);
      c.i32Const(2);
      c.i32Mul();
      c.arrayNewDefault(this.deps.bytesBufType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeS();
      c.brIf(1);
      c.localGet(IN);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(IN);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(I);
      c.i32Add();
      c.arrayGetU(this.deps.bytesBufType());
      c.localSet(B);
      c.localGet(B);
      c.i32Const(4);
      c.i32ShrU();
      c.localSet(HI);
      c.localGet(B);
      c.i32Const(0xf);
      c.i32And();
      c.localSet(LO);
      c.localGet(OUT);
      c.localGet(I);
      c.i32Const(2);
      c.i32Mul();
      this.pushHexDigit(c, HI);
      c.arraySet(this.deps.bytesBufType());
      c.localGet(OUT);
      c.localGet(I);
      c.i32Const(2);
      c.i32Mul();
      c.i32Const(1);
      c.i32Add();
      this.pushHexDigit(c, LO);
      c.arraySet(this.deps.bytesBufType());
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(N);
      c.i32Const(2);
      c.i32Mul();
      c.structNew(this.deps.bytesStructType());
      this.mb.setBody(
        idx,
        [I32, { kind: "ref", nullable: false, typeIndex: this.deps.bytesBufType() }, I32, I32, I32, I32],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> root` — `readable.setEncoding('utf8')` (the ONLY encoding
   * this pass ports — any other literal refuses BY NAME at the emitter
   * dispatch site, never reaching here): flips RS_ENCODING on, and if
   * bytes are ALREADY buffered from before encoding turned on, drains
   * the WHOLE list (`takeFromChunks` over the current `RS_LENGTH`),
   * decodes it through the SAME stateful step, and re-appends the result
   * as ONE combined chunk — Node's own `setEncoding`'s "concat existing
   * buffer, redecode, one re-pushed entry" algorithm (lift.cjs), ported.
   * Never emits (matches Node: setEncoding manipulates state.buffer
   * directly, no addChunk/'data'). */
  setEncodingUtf8Core(): number {
    return this.cached("setEncodingUtf8Core", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [root]), "%w.rs.setEncodingUtf8");
      const c = new Code();
      const ROOT = 0, ST = 1, EXISTING = 2, DECODED = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_ENCODING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.call(this.takeFromChunks());
      c.localSet(EXISTING);
      c.localGet(ST);
      c.localGet(EXISTING);
      c.call(this.decodeUtf8Step());
      c.localSet(DECODED);
      c.localGet(DECODED);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(DECODED);
      c.i32Const(0);
      c.call(this.appendChunk());
      c.end();
      c.end();
      c.end();
      c.localGet(ROOT);
      this.mb.setBody(idx, [this.stateRef(), this.deps.bytesRef(), this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> root` — `readable.setEncoding('hex')`. `setEncodingUtf8Core`'s
   * exact shape (flip RS_ENCODING on, redecode any already-buffered
   * content as ONE combined re-pushed chunk) with `hexEncodeStep` in
   * place of `decodeUtf8Step` — no `state` param needed there (hex is
   * stateless, `hexEncodeStep`'s own header), and RS_ENCODING is set to
   * 2, not 1. */
  setEncodingHexCore(): number {
    return this.cached("setEncodingHexCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [root]), "%w.rs.setEncodingHex");
      const c = new Code();
      const ROOT = 0, ST = 1, EXISTING = 2, DECODED = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(2);
      c.structSet(this.stateT(), RS_ENCODING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.call(this.takeFromChunks());
      c.localSet(EXISTING);
      c.localGet(EXISTING);
      c.call(this.hexEncodeStep());
      c.localSet(DECODED);
      c.localGet(DECODED);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(DECODED);
      c.i32Const(0);
      c.call(this.appendChunk());
      c.end();
      c.end();
      c.end();
      c.localGet(ROOT);
      this.mb.setBody(idx, [this.stateRef(), this.deps.bytesRef(), this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /* ── push family ───────────────────────────────────────────────────── */

  /** `(root, bytes, front: i32) -> i32(should-push-more)` —
   * scr_stream_add_chunk ported: push-after-EOF errors (destroy path,
   * matching Node's `ERR_STREAM_PUSH_AFTER_EOF`); otherwise the DIRECT-
   * EMIT fast path (flowing + empty buffer + not mid-`_read` + not a
   * front/unshift push + a live 'data' listener ⇒ synchronous 'data',
   * skipping the buffer entirely) or buffering + a collapsed 'readable'
   * kick. */
  pushCore(): number {
    return this.cached("pushCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.bytesRef(), I32], [I32]), "%w.rs.push");
      const c = new Code();
      const ROOT = 0, BYTES = 1, FRONT = 2, ST = 3, COND = 4, ARGS = 5, DECODED = 6, RET = 7;
      const pushCanPushMore = (): void => {
        // canPushMore(state): !ended && (length < hwm || length==0) —
        // the lifted source's OWN function (lift2.cjs), returned
        // VERBATIM from every exit of this one (zero-length, front,
        // back, and the final fall-through) — not just the fall-through,
        // per B3/R1's fix.
        c.localGet(ST);
        c.structGet(this.stateT(), RS_ENDED);
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_LENGTH);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_HWM);
        c.f64Lt();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_LENGTH);
        c.f64Const(0);
        c.f64Eq();
        c.i32Or();
        c.i32And();
      };
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // ZERO-LENGTH, BEFORE the ended/destroyed checks — B3/R1's fix,
      // Node's OWN position (lift2.cjs's readableAddChunkPushByteMode:
      // the `chunk.length<=0` branch comes BEFORE the `kEnded` check),
      // which is what makes a zero-length push AFTER EOF a silent
      // `canPushMore()` (false) rather than ERR_STREAM_PUSH_AFTER_EOF
      // (pb/b2's pin) — R1 and B3 are the SAME fix. Front (unshift) and
      // back (push) differ here too: the lifted
      // readableAddChunkUnshiftByteMode's zero-length branch does NOT
      // clear `reading` and does NOT call `maybeReadMore` — only the
      // push (back) side does both.
      c.localGet(BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      c.localGet(FRONT);
      c.ifVoid();
      c.else_();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING);
      c.localGet(ROOT);
      c.call(this.maybeReadMoreCore());
      c.end();
      pushCanPushMore();
      c.return_();
      c.end();
      // The EOF guard is DIFFERENT for front (unshift) vs back (push) —
      // Node's real `readableAddChunk`: the back path checks `state.
      // ended` (push() after push(null), ERR_STREAM_PUSH_AFTER_EOF) and
      // `state.destroyed`; the FRONT path checks `state.endEmitted`
      // instead (ERR_STREAM_UNSHIFT_AFTER_END_EVENT) and does NOT
      // consult `ended`/`destroyed` at all — unshift() called from a
      // 'readable'/'data' handler that runs AFTER push(null) already set
      // `ended` (but BEFORE 'end' has emitted) is perfectly legal
      // (1686's pin: `unshift()` inside the 'readable' callback, called
      // after a `push(null)` earlier in the same synchronous script).
      c.localGet(FRONT);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.ifVoid();
      c.localGet(ROOT);
      this.deps.buildErrorLit(
        c,
        "%Error",
        "Error",
        (cc) => this.deps.lit(cc, "stream.unshift() after end event"),
        "ERR_STREAM_UNSHIFT_AFTER_END_EVENT",
      );
      c.call(this.destroyErrCore());
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifVoid();
      c.localGet(ROOT);
      this.deps.buildErrorLit(
        c,
        "%Error",
        "Error",
        (cc) => this.deps.lit(cc, "stream.push() after EOF"),
        "ERR_STREAM_PUSH_AFTER_EOF",
      );
      c.call(this.destroyErrCore());
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING);
      // PASS 2: the encoder/decoder choke point — Node's real
      // `readableAddChunk` decodes a non-front chunk through `state.
      // decoder` BEFORE it ever reaches `addChunk` (so the direct-emit
      // fast path below sees the DECODED form too), never on the front
      // (unshift) path, which this `else` branch (the back/push path) is
      // the only place this runs. utf8 (RS_ENCODING===1): a decode that
      // yields nothing yet (a still-incomplete multi-byte sequence) skips
      // addChunk entirely — `maybeReadMore` still runs, matching Node's
      // own `else maybeReadMore(...)` arm — WITHOUT scheduling 'readable'
      // or touching the buffer, so a lone split byte produces no
      // observable event at all (1745/2627's mechanism). hex
      // (RS_ENCODING===2): STAGE C PASS 2 — `hexEncodeStep`'s own header,
      // no held-back state, no early-return arm needed (measured: hex
      // never yields "nothing yet").
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(BYTES);
      c.call(this.decodeUtf8Step());
      c.localSet(DECODED);
      c.localGet(DECODED);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32LeS();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.maybeReadMoreCore());
      pushCanPushMore();
      c.return_();
      c.end();
      c.localGet(DECODED);
      c.localSet(BYTES);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      c.localGet(BYTES);
      c.call(this.hexEncodeStep());
      c.localSet(BYTES);
      c.end();
      c.end();
      c.end();
      // addChunk(stream, state, chunk, front) — lift.cjs's own condition
      // does NOT exclude `front` (an unshift CAN take the direct-emit
      // path too, if flowing+sync+dataListening+length===0 all hold);
      // every operand here is a pure read, so unconditional evaluation +
      // i32And-chaining is safe (the i32.and-no-short-circuit gotcha is
      // about skipping UNSAFE operand evaluation, not about combining
      // already-safe comparisons).
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_SYNC);
      c.i32Eqz();
      c.i32And();
      c.localGet(ROOT);
      this.deps.lit(c, "data");
      c.call(this.deps.countOf());
      c.f64Const(0);
      c.f64Gt();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.localSet(COND);
      c.localGet(COND);
      c.ifVoid();
      // Node's real `addChunk` direct-emit arm touches only
      // `awaitDrainWriters` (out of this tier's scope, no `pipe()`) and
      // `stream.emit('data', chunk)` — no `emittedReadable` clear here
      // (dropped: the reviewer proved it unobservable either way — h1's
      // own probe fails IDENTICALLY with the clear reinstated, isolating
      // its root cause to something else entirely: this tier's single
      // tri-state `RS_FLOWING` does not model Node's real kHasFlowing/
      // kReadableListening dual-bit legacy pause()/resume() interaction
      // with a 'readable' listener, a materially deeper gap outside this
      // round's scope — and an unmotivated deviation from the lifted
      // source accumulates risk even when benign today).
      this.emitDataFrom(c, ROOT, BYTES, ST, ARGS);
      c.else_();
      c.localGet(ST);
      c.localGet(BYTES);
      c.localGet(FRONT);
      c.call(this.appendChunk());
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.end();
      c.end();
      c.localGet(ROOT);
      c.call(this.maybeReadMoreCore());
      pushCanPushMore();
      // PASS 2: settle a parked for-await waiter now that this push may
      // have produced new data — saved to RET FIRST so checkWaiterCore's
      // own readCore call (which mutates RS_LENGTH etc) cannot perturb
      // push()'s own return value.
      c.localSet(RET);
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      c.localGet(RET);
      this.mb.setBody(idx, [this.stateRef(), I32, this.deps.dynArrRef(), this.deps.bytesRef(), I32], c.bytes());
      return idx;
    });
  }

  /** `(root, str, front: i32) -> i32` — `push(str)`'s decode, keyed by
   * the stream's OWN `RS_PUSH_ENC` (the `defaultEncoding` option's
   * effect — utf8 unless the construction options or `readable.
   * pushEncoding` said otherwise), then pushCore. (`pushStrEnc`'s
   * explicit PER-CALL encoding, which ignores RS_PUSH_ENC entirely, is
   * `pushStrEncCore` below.) */
  pushStrCore(): number {
    return this.cached("pushStrCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.strRef(), I32], [I32]), "%w.rs.pushStr");
      const c = new Code();
      const ROOT = 0, STR = 1, FRONT = 2, ST = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ROOT);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_PUSH_ENC);
      c.localGet(STR);
      c.call(this.fromStrByEncCore());
      c.localGet(FRONT);
      c.call(this.pushCore());
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, encTag: i32, str) -> bytes` — the exhaustive `RS_PUSH_ENC`/
   * `pushStrEnc` dispatcher over `ENC_NAMES`: `encTag` only ever arrives
   * as a compile-time-checked literal-turned-enum (readable.pushEncoding/
   * pushStrEnc's own emitter-side dispatch, or RS_PUSH_ENC's own default
   * 0), so the trailing `unreachable` is a true dead arm, not a refusal a
   * program can ever reach — the exhaustive-dispatch discipline's
   * defined fallthrough, not a silent one. */
  private fromStrByEncCore(): number {
    return this.cached("fromStrByEncCore", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32, this.deps.strRef()], [this.deps.bytesRef()]), "%w.rs.fromStrByEnc");
      const c = new Code();
      const TAG = 0, STR = 1;
      for (let i = 0; i < ENC_NAMES.length; i++) {
        c.localGet(TAG);
        c.i32Const(i);
        c.i32Eq();
        c.ifVoid();
        c.localGet(STR);
        c.call(this.deps.fromStrByEnc(i));
        c.return_();
        c.end();
      }
      c.unreachable();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, str, encTag: i32, front: i32) -> i32` — `push(str, enc)`'s
   * explicit PER-CALL encoding: ignores RS_PUSH_ENC entirely (the literal
   * at the call site always wins), then pushCore — mirrors pushStrCore's
   * shape exactly, minus the state read. */
  pushStrEncCore(): number {
    return this.cached("pushStrEncCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(
        this.mb.funcType([root, this.deps.strRef(), I32, I32], [I32]),
        "%w.rs.pushStrEnc",
      );
      const c = new Code();
      const ROOT = 0, STR = 1, ENC = 2, FRONT = 3;
      c.localGet(ROOT);
      c.localGet(ENC);
      c.localGet(STR);
      c.call(this.fromStrByEncCore());
      c.localGet(FRONT);
      c.call(this.pushCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, encTag: i32) -> root` — `readable.pushEncoding`: sets the
   * stream's default push encoding (RS_PUSH_ENC), chaining (the
   * construction-option follow-up and the same-shaped `defaultEncoding`
   * chain both answer the receiver). */
  setPushEncCore(): number {
    return this.cached("setPushEncCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, I32], [root]), "%w.rs.setPushEnc");
      const c = new Code();
      const ROOT = 0, ENC = 1, ST = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(ENC);
      c.structSet(this.stateT(), RS_PUSH_ENC);
      c.localGet(ROOT);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `push(null)`: Node's real `onEofChunk` (lift.cjs),
   * ported exactly (the gate-round B2/R4/R5 fix — the prior design's
   * "outside a _read call, run flow() synchronously" heuristic
   * approximated this function's OWN ultimate effect without actually
   * BEING it, which is why it needed a second invented flag to gate
   * correctly; `onEofChunk` needs none, because the real branch is keyed
   * on `sync` alone). Always returns false (push(null) has no other
   * caller-visible answer; `canPushMore` after `ended=true` collapses to
   * false regardless). */
  pushNullCore(): number {
    return this.cached("pushNullCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.pushNull");
      const c = new Code();
      const ROOT = 0, ST = 1, FLUSHED = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      // PASS 2: decoder.end() — a still-incomplete trailing utf8 sequence
      // flushes as its replacement char(s) (toStrHelper's own maximal-
      // subpart end-of-buffer rule already does this — measured against
      // Node directly: a truncated tail at end() is ONE U+FFFD, never a
      // silent drop), re-encoded and appended as one more chunk BEFORE
      // `ended` flips (so it is still deliverable through the ordinary
      // buffered/direct-emit paths below, same as any other push).
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DEC_PENDING);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DEC_PENDING);
      c.call(this.deps.toStrUtf8());
      c.call(this.deps.bytesFromStrUtf8());
      c.localSet(FLUSHED);
      c.localGet(FLUSHED);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(FLUSHED);
      c.i32Const(0);
      c.call(this.appendChunk());
      c.end();
      c.localGet(ST);
      c.refNull(this.deps.bytesStructType());
      c.structSet(this.stateT(), RS_DEC_PENDING);
      c.end();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_ENDED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_SYNC);
      c.ifVoid();
      // if (kSync): emitReadable(stream) — the SCHEDULER, tick-deferred.
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.else_();
      // else: state &= ~kNeedReadable; state |= kEmittedReadable;
      // emitReadable_(stream) — called SYNCHRONOUSLY (not scheduled);
      // `opReadable` IS `emitReadable_`'s body (it also unconditionally
      // calls `flow()` at its own end, which is what drains a flowing
      // stream right here — R4/R5's "EOF-path readable emissions").
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.call(this.opReadable());
      c.end();
      // GATE FIX (1747's mandatory dig — found by source reading, not
      // instrumentation): `pushCore`'s own tail settles a parked
      // for-await waiter (checkWaiterCore's own header lists "pushCore's
      // tail, opEnd, destroyErrCore" as its three non-creation triggers)
      // but `pushNullCore` — a DIFFERENT function, EOF's own push —
      // never did. A waiter parked BEFORE any real data ever arrives,
      // then answered by push(null) with nothing else to drive a
      // subsequent read()/resume() (Transform's own internal _final ->
      // flushDoneCore -> pushNullCore chain when NOTHING was ever
      // written is exactly this shape, and the ONLY thing this pass's
      // own Transform construction can do to a for-await consumer that
      // parked first), had nothing left to re-examine it: `readCore`
      // (called from checkWaiterCore's own first, parking invocation)
      // sees RS_ENDED still false at that moment (correctly stays
      // parked), and NOTHING calls checkWaiterCore again afterward — no
      // trap, no error, the tick pump simply runs dry with the waiter's
      // promise never settled (d11-park-then-end.ts: the minimal
      // repro, zero concurrency, zero data, park-then-immediately-end;
      // d7's own "two concurrent for-await loops" framing was a RED
      // HERRING — d10 confirmed the SAME hang exists with no second
      // loop involved at all, once isolated far enough). Same discipline
      // as pushCore's own tail: settle a parked waiter whenever this
      // function's own effects (here, RS_ENDED flipping true) could
      // newly answer it. checkWaiterCore's own idempotent no-op-when-
      // nothing-parked guard makes this safe to call unconditionally,
      // matching every one of its other four call sites.
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      c.i32Const(0);
      this.mb.setBody(idx, [this.stateRef(), this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `endReadable` (lift2.cjs): schedules
   * the 'end' tick, gated ONLY by `!endEmitted` (plus this file's own
   * `end_scheduled` dedup — RS_END_SCHEDULED's own header). R2's fix:
   * called ONLY from `readCore`'s three call sites (Node's `read()` is
   * the ONLY caller of `endReadable` in the lifted source — NOT from
   * `pushNullCore`/push(null) directly, which is what the prior design
   * did, proactively ending a stream nobody ever called `read()`/
   * `resume()`/`pipe()` on and changing exit codes on ordinary programs
   * that have no consumer at all — pb/c3's pin: `push(null)` alone,
   * with 'end'/'close' listeners but no read/flow driver, never emits
   * either, byte-exact against Node). `endReadableNT` — the tick body —
   * is `opEnd`, unchanged in shape (its own re-check at tick time
   * already covers "one more unshift snuck in"). */
  private endReadableCore(): number {
    return this.cached("endReadableCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.endReadable");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_SCHEDULED);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_END_SCHEDULED);
      c.localGet(ROOT);
      c.i32Const(OP_END);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `emitReadable` (lift.cjs): the
   * SCHEDULER half (clears `needReadable` unconditionally, collapses
   * repeat calls via `emittedReadable`, schedules the OP_READABLE tick
   * — `emitReadable_`/`opReadable` is the tick BODY, called through
   * `dispatchOne` here, and ALSO directly for the synchronous EOF path,
   * `pushNullCore`'s own call). */
  private scheduleReadable(): number {
    return this.cached("scheduleReadable", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.scheduleReadable");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_EMITTED_READABLE);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.i32Const(OP_READABLE);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `maybeReadMore` (lift2.cjs, R3): the
   * SCHEDULER half (guarded by `reading`/`readingMore` — `kConstructed`
   * is always true here, this tier fences the async-`construct` option
   * entirely). `maybeReadMore_`/`opReadMore` is the tick body. */
  private maybeReadMoreCore(): number {
    return this.cached("maybeReadMoreCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.maybeReadMore");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING_MORE);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READING_MORE);
      c.localGet(ROOT);
      c.i32Const(OP_READMORE);
      c.call(this.scheduleTick());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `() -> void`'s tick body — Node's real `maybeReadMore_` (lift2.cjs):
   * loops `stream.read(0)` while under the highWaterMark (or flowing
   * with an empty buffer), stopping once a round produces no growth —
   * pb/b6's pin (`_read` filling the buffer to `highWaterMark` with
   * NOTHING else driving it — no 'data' listener, no explicit `.read()`
   * calls — is this loop's own doing, not `_read`'s). */
  private opReadMore(): number {
    return this.cached("opReadMore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opReadMore");
      const c = new Code();
      const ROOT = 0, ST = 1, LEN = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.block();
      c.loop();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Lt();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.i32Or();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localSet(LEN);
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.localGet(LEN);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Eq();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_READING_MORE);
      this.mb.setBody(idx, [this.stateRef(), F64], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — Node's real `nReadingNextTick` (lift2.cjs's
   * `Readable.prototype.on` override, the 'readable' arm): a bare
   * `stream.read(0)`, scheduled via a plain `process.nextTick`, not
   * called synchronously from `onReadableAdded` itself — 2572's fix (a
   * synchronous priming call there clears `sync` before a same-turn
   * `push(null)` gets to run, which flips `onEofChunk`'s own branch and
   * produces an extra, Node-never-emits 'readable' cycle). */
  private opPrimeRead(): number {
    return this.cached("opPrimeRead", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opPrimeRead");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** Emits 'data' with a one-element dyn-boxed tuple through events.ts's
   * general dispatch (the emitData ABI decision, this file's header) —
   * inlined at each call site against the CALLER's own local slots
   * (`rootLocal`/`bytesLocal`/`stLocal` already hold the values;
   * `argsScratch` is a spare local the caller declared for this).
   *
   * PASS 2: two additions, both keyed off `stLocal`'s own state (never a
   * second read of anything the caller hasn't already resolved) —
   * (1) a stream/consumers subscriber tees the RAW bytes into
   * RS_CONSUMER_ACC BEFORE the string/bytes choice below (uniform
   * accumulation regardless of encoding — 2629's r4/r5 "buffer() takes
   * the utf8 bytes of a string-chunk stream" needs exactly this order);
   * (2) the dyn box itself becomes a STRING when RS_ENCODING is on
   * (`bytesLocal` is always a COMPLETE, valid utf8 slice under encoding
   * mode by `decodeUtf8Step`'s own construction, so `toStrUtf8` never
   * needs to consult RS_DEC_PENDING here — it already only ever sees
   * fully-decoded content). */
  private emitDataFrom(c: Code, rootLocal: number, bytesLocal: number, stLocal: number, argsScratch: number): void {
    c.localGet(stLocal);
    c.structGet(this.stateT(), RS_CONSUMER_KIND);
    c.ifVoid();
    c.localGet(stLocal);
    c.localGet(stLocal);
    c.structGet(this.stateT(), RS_CONSUMER_ACC);
    c.refIsNull();
    c.ifResult(this.deps.bytesRef());
    c.localGet(bytesLocal);
    c.else_();
    c.localGet(stLocal);
    c.structGet(this.stateT(), RS_CONSUMER_ACC);
    c.refAsNonNull();
    c.localGet(bytesLocal);
    c.call(this.concatTwoBytes());
    c.end();
    c.structSet(this.stateT(), RS_CONSUMER_ACC);
    c.end();
    c.i32Const(1); // the dyn-vec's own `len` field, ahead of `buf`
    c.localGet(stLocal);
    c.structGet(this.stateT(), RS_ENCODING);
    c.ifResult(this.deps.dynRef());
    this.deps.boxStr(c, (cc) => {
      cc.localGet(bytesLocal);
      cc.call(this.deps.toStrUtf8());
    });
    c.else_();
    this.deps.boxBytes(c, (cc) => this.deps.pushBytesPayload(cc, (ccc) => ccc.localGet(bytesLocal)));
    c.end();
    c.arrayNewFixed(this.deps.dynArrBufType(), 1);
    c.structNew(this.deps.dynArrStructType());
    c.localSet(argsScratch);
    c.localGet(rootLocal);
    this.deps.lit(c, "data");
    c.localGet(argsScratch);
    c.call(this.deps.emitDispatch());
    c.drop(); // hadListeners is not observed here
  }

  /** `(state, f64 take) -> bytes` — takes exactly `take` bytes off the
   * front of the chunk list, spanning as many chunks as needed
   * (scr_stream_rbuf_take's byte-mode branch), advancing each consumed
   * chunk's `off` and dropping it once exhausted, decrementing
   * `state.length`. `take` is always <= state.length (the caller's own
   * invariant — read_n clamps before calling). Single-chunk-exact-take is
   * NOT special-cased: array.copy over one segment is exactly as cheap
   * as the general loop's one iteration. */
  private takeFromChunks(): number {
    return this.cached("takeFromChunks", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), F64], [this.deps.bytesRef()]), "%w.rs.take");
      const c = new Code();
      const ST = 0, TAKE = 1, TOTAL = 2, OUT = 3, DESTOFF = 4, REMAIN = 5, H = 6, AVAIL = 7, HERE = 8;
      c.localGet(TAKE);
      c.i32TruncF64S();
      c.localSet(TOTAL);
      c.localGet(TOTAL);
      c.arrayNewDefault(this.deps.bytesBufType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(DESTOFF);
      c.localGet(TOTAL);
      c.localSet(REMAIN);
      c.block();
      c.loop();
      c.localGet(REMAIN);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.localSet(H);
      // avail = head.bytes.len - head.off
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Sub();
      c.localSet(AVAIL);
      c.localGet(AVAIL);
      c.localGet(REMAIN);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(AVAIL);
      c.else_();
      c.localGet(REMAIN);
      c.end();
      c.localSet(HERE);
      // array.copy(out, destOff, head.bytes.storage, head.bytes.off + head.off, here)
      c.localGet(OUT);
      c.localGet(DESTOFF);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_STORAGE);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_OFF);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Add();
      c.localGet(HERE);
      c.arrayCopy(this.deps.bytesBufType(), this.deps.bytesBufType());
      c.localGet(DESTOFF);
      c.localGet(HERE);
      c.i32Add();
      c.localSet(DESTOFF);
      c.localGet(REMAIN);
      c.localGet(HERE);
      c.i32Sub();
      c.localSet(REMAIN);
      // advance/drop the head chunk
      c.localGet(HERE);
      c.localGet(AVAIL);
      c.i32GeS();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_NEXT);
      c.structSet(this.stateT(), RS_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.refNull(this.chunkT());
      c.structSet(this.stateT(), RS_TAIL);
      c.end();
      c.else_();
      c.localGet(H);
      c.localGet(H);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.localGet(HERE);
      c.i32Add();
      c.structSet(this.chunkT(), CHUNK_OFF);
      c.end();
      c.br(0);
      c.end();
      c.end();
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(TAKE);
      c.f64Sub();
      c.structSet(this.stateT(), RS_LENGTH);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(TOTAL);
      c.structNew(this.deps.bytesStructType());
      this.mb.setBody(
        idx,
        [I32, { kind: "ref", nullable: false, typeIndex: this.deps.bytesBufType() }, I32, I32, this.chunkRef(), I32, I32],
        c.bytes(),
      );
      return idx;
    });
  }

  /* ── read / call_read / flow ──────────────────────────────────────── */

  /** `(root) -> void` — the bracketed `this._read(state.highWaterMark)`
   * call, matching `Readable.prototype.read`'s OWN inline shape (lift3.
   * cjs) exactly: `reading` and `sync` are set TOGETHER right before the
   * call; the call itself is wrapped in a try/catch (`errorOrDestroy` on
   * throw — D2's fix, the gate round's callRead header wrongly claimed
   * this shape already; the try/catch IS part of it), and `sync` is
   * cleared right after, UNCONDITIONALLY, whether the call threw or not
   * — `reading` is Node's signal for "is a _read cycle still
   * outstanding", and it is cleared ONLY by `push()`'s own logic
   * (readableAddChunkPushByteMode's `state[kState] &= ~kReading`), never
   * by `read()`'s post-call code. The gate-round B2 finding: the prior
   * design cleared BOTH here unconditionally, which destroyed the "did
   * _read push synchronously" signal `readCore`'s own doRead branch
   * needs to decide whether to recompute `n`. The caller (`readCore`'s
   * doRead branch — the ONLY caller now) owns the `reading`/`ended`/
   * `destroyed`/absent-closure gate; this function no longer re-derives
   * it. */
  private callRead(): number {
    return this.cached("callRead", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.callRead");
      const c = new Code();
      const ROOT = 0, ST = 1, ERR = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_CLOS);
      c.refIsNull();
      c.ifVoid();
      c.return_(); // defensive only — construction always supplies one
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_SYNC);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_CLOS);
      c.localGet(ROOT);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READ_THUNK);
      c.callRef(this.readThunkSig());
      // try { this._read(hwm) } catch (err) { errorOrDestroy(this, err) }
      // — D2's fix. `tryCatchAsError` catches ONLY an Error-shaped OBJ
      // throw (this tier's `RS_ERROR` slot has no other shape to hold);
      // anything else stays pending and propagates as before (named, not
      // silently dropped — D2 pins pb/f7's shape, a genuine `new Error`).
      this.deps.tryCatchAsError(c);
      c.localSet(ERR);
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(ERR);
      c.call(this.destroyErrCore());
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_SYNC);
      this.mb.setBody(idx, [this.stateRef(), this.deps.errRef()], c.bytes());
      return idx;
    });
  }

  /** `(state, n: f64, absent: i32) -> f64` — Node's real `howMuchToRead`
   * (lift4.cjs), verbatim: 0 when nothing can be given (bad `n`, or
   * ended with an empty buffer); one whole object in object mode (out of
   * this tier's scope — objectMode is always-false, never reached); an
   * ABSENT `n` (Node's NaN) takes only the FRONT buffered entry's
   * remaining bytes while flowing with a non-empty buffer (so 'data'
   * preserves each push()'s own chunk boundary — 1685's pin) and the
   * WHOLE buffer otherwise; an explicit `n` clamps to what's available,
   * or to everything once ended. Factored out because `readCore` calls
   * it TWICE (Node's own `read()` does too — once up front, again after
   * a synchronous `_read` push invalidates the first answer). */
  private howMuchToRead(): number {
    return this.cached("howMuchToRead", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), F64, I32], [F64]), "%w.rs.howMuchToRead");
      const c = new Code();
      const ST = 0, N = 1, ABSENT = 2;
      // Node's real check is `n<=0`, where an absent `n` is NaN and
      // `NaN<=0` is ALWAYS false — so the "n<=0" arm must never fire for
      // absent reads. This build passes a literal 0 as N's placeholder
      // when ABSENT is set, so the comparison has to be gated explicitly
      // (a bare N<=0 would wrongly true for every absent/flow() call).
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(N);
      c.f64Const(0);
      c.f64Le();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.i32Or();
      c.ifResult(F64);
      c.f64Const(0);
      c.else_();
      c.localGet(ABSENT);
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.i32And();
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.i32Sub();
      c.f64ConvertI32S();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.end();
      c.else_();
      c.localGet(N);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Le();
      c.ifResult(F64);
      c.localGet(N);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.ifResult(F64);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.else_();
      c.f64Const(0);
      c.end();
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, n: f64, absent: i32) -> bytes|null` — `Readable.prototype.
   * read`, ported line-for-line from the lifted source (lift3.cjs; the
   * gate-round's ground truth) with this tier's scope cuts: no dynamic
   * highWaterMark growth (`n > hwm` raising it — no pass-1/2 claim needs
   * it), no encoding/decoder/objectMode, no `errorEmitted`/`closeEmitted`
   * gate on the final 'data' emission (named, not silently dropped: the
   * gate-round's fix list does not touch this condition, and every
   * pass-1 claim that BOTH successfully takes AND is errorEmitted/
   * closeEmitted at that instant does not exist — adding the exact gate
   * back would need RS_ERROR_EMITTED/RS_CLOSE_EMITTED, which the gate
   * round named dead and this stays within its own fix list rather than
   * re-growing the struct for an unflagged corner). */
  readCore(): number {
    return this.cached("readCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, F64, I32], [this.deps.bytesRef()]), "%w.rs.read");
      const c = new Code();
      const ROOT = 0, N = 1, ABSENT = 2, ST = 3, NW = 4, RESULT = 5, ARGS = 6, DOREAD = 7, ISFIN = 8, TRUNCN = 9;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // Node's real n-coercion, the OTHER clause (D4; `n===undefined
      // -> NaN` is D1's fix, already the ABSENT flag by the time this
      // runs): `!Number.isInteger(n) -> n=parseInt(n,10)`. parseInt
      // stringifies first: a FINITE non-integer truncates toward zero
      // (its leading digits before the decimal point); a NON-finite
      // value (+-Infinity) stringifies to a leading non-digit, so
      // parseInt answers NaN — which folds into the SAME absent path
      // here, since nothing downstream distinguishes "the arg was
      // omitted" from "Node's own coercion turned it into NaN" (pb/f10:
      // read(Infinity) reads the whole buffer, exactly like a bare
      // read()). Lands at the very top, matching Node's OWN placement
      // (before `nOrig` is even captured) — NOT at the take site, which
      // is what corrupted the length for a fractional size instead of
      // truncating it (the coercion-matrix pin in 1686). isInteger(n)
      // is tested as `isFinite(n) && trunc(n)===n` — `isFinite` itself
      // as `n-n===0` (NaN-NaN and Infinity-Infinity both give NaN,
      // never 0; every finite n, including -0, gives exactly 0). NOT
      // exact for one sub-microscopic fractional corner — SEMANTICS.md
      // S046 carries the measured boundary and the rationale; this
      // comment deliberately does not restate it (the entry is the
      // single source).
      c.localGet(N);
      c.localGet(N);
      c.f64Sub();
      c.f64Const(0);
      c.f64Eq();
      c.localSet(ISFIN);
      c.localGet(N);
      c.f64Trunc();
      c.localSet(TRUNCN);
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(ISFIN);
      c.localGet(TRUNCN);
      c.localGet(N);
      c.f64Eq();
      c.i32And();
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ISFIN);
      c.ifVoid();
      c.localGet(TRUNCN);
      c.localSet(N);
      c.else_();
      c.f64Const(NaN);
      c.localSet(N);
      c.i32Const(1);
      c.localSet(ABSENT);
      c.end();
      c.end();
      // if (n !== 0) state.emittedReadable = false — absent (NaN) is
      // always !==0.
      c.localGet(ABSENT);
      c.localGet(N);
      c.f64Const(0);
      c.f64Ne();
      c.i32Or();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.end();
      // read(0)-to-trigger-readable fast path.
      c.localGet(ABSENT);
      c.i32Eqz();
      c.localGet(N);
      c.f64Const(0);
      c.f64Eq();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Const(0);
      c.f64Ne();
      c.ifResult(I32);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Ge();
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.else_();
      c.localGet(ROOT);
      c.call(this.scheduleReadable());
      c.end();
      c.refNull(this.deps.bytesStructType());
      c.return_();
      c.end();
      c.end();
      // n = howMuchToRead(n, state)
      c.localGet(ST);
      c.localGet(N);
      c.localGet(ABSENT);
      c.call(this.howMuchToRead());
      c.localSet(NW);
      // if (n===0 && ended): finish up.
      c.localGet(NW);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.end();
      c.refNull(this.deps.bytesStructType());
      c.return_();
      c.end();
      // doRead computation.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_NEED_READABLE);
      c.localSet(DOREAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(NW);
      c.f64Sub();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Lt();
      c.i32Or();
      c.ifVoid();
      c.i32Const(1);
      c.localSet(DOREAD);
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Or();
      c.ifVoid();
      c.i32Const(0);
      c.localSet(DOREAD);
      c.else_();
      c.localGet(DOREAD);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.localGet(ROOT);
      c.call(this.callRead());
      // "If _read pushed data synchronously, then `reading` will be
      // false, and we need to re-evaluate how much data we can return."
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.localGet(ABSENT);
      c.call(this.howMuchToRead());
      c.localSet(NW);
      c.end();
      c.end();
      c.end();
      // ret = n>0 ? fromList(n,state) : null
      c.localGet(NW);
      c.f64Const(0);
      c.f64Gt();
      c.ifResult(this.deps.bytesRef());
      c.localGet(ST);
      c.localGet(NW);
      c.call(this.takeFromChunks());
      c.else_();
      c.refNull(this.deps.bytesStructType());
      c.end();
      c.localSet(RESULT);
      c.localGet(RESULT);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Le();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.f64Const(0);
      c.localSet(NW);
      c.else_();
      // NW's `state.length -= NW` already happened INSIDE takeFromChunks
      // (its own documented contract) — a second decrement here would
      // double-subtract every successful take (found via d2's dropped
      // second 'data' event: length going 2->0 instead of 2->1 after
      // taking 1 byte off a 2-byte buffer).
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      // "if we tried to read() past the EOF, then emit end" — nOrig!==n:
      // absent is always !== (NaN semantics), an explicit n compares its
      // ORIGINAL value against the post-take NW.
      c.localGet(ABSENT);
      c.localGet(N);
      c.localGet(NW);
      c.f64Ne();
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.endReadableCore());
      c.end();
      c.end();
      c.localGet(RESULT);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      this.emitDataFrom(c, ROOT, RESULT, ST, ARGS);
      c.end();
      c.localGet(RESULT);
      this.mb.setBody(
        idx,
        [this.stateRef(), F64, this.deps.bytesRef(), this.deps.dynArrRef(), I32, I32, F64],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> void` — while flowing, repeatedly pulls everything
   * currently available (calling `_read` to refill when empty) and lets
   * `readCore` emit 'data' as it goes, until nothing more is available
   * (scr_stream_flow). Stops early if a 'data' listener threw (the
   * exception cell is set — the caller's own pending-check propagates
   * it; this loop just must not keep pumping past it). */
  flow(): number {
    return this.cached("flow", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.flow");
      const c = new Code();
      const ROOT = 0, ST = 1, CHUNK = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.block();
      c.loop();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Ne();
      c.brIf(1);
      c.globalGet(this.deps.excKind());
      c.brIf(1);
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(1);
      c.call(this.readCore());
      c.localSet(CHUNK);
      c.localGet(CHUNK);
      c.refIsNull();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.bytesRef()], c.bytes());
      return idx;
    });
  }

  /* ── PASS 2: for-await (readable.nextChunkDyn) ────────────────────────
   * See RS_WAITER's own header for the single-slot/no-concurrency-guard
   * rationale (measured against Node directly: it does NOT throw). ONE
   * shared decision function (`checkWaiterCore`) serves both
   * `nextChunkDyn`'s own creation path and every state transition that
   * could newly answer an already-parked waiter (pushCore's tail, opEnd,
   * destroyErrCore) — settling is idempotent (it no-ops once RS_WAITER
   * is null), so calling it defensively from all four costs nothing on
   * the paths where nothing changed. */

  /** Pushes ONE dyn-boxed value for `chunkLocal` — a STRING box under
   * RS_ENCODING (matching for-await's checked-dynamic chunk contract,
   * lowerForAwaitReadable's header), a BYTES box otherwise. Mirrors
   * emitDataFrom's own box choice exactly (same representation, same
   * reason), factored out since nextChunkDyn's fulfillment is the boxed
   * dyn VALUE itself (the await site's static type is DYN), not a
   * 'data'-event tuple. */
  private emitBoxChunkAsDyn(c: Code, stLocal: number, chunkLocal: number): void {
    c.localGet(stLocal);
    c.structGet(this.stateT(), RS_ENCODING);
    c.ifResult(this.deps.dynRef());
    this.deps.boxStr(c, (cc) => {
      cc.localGet(chunkLocal);
      cc.call(this.deps.toStrUtf8());
    });
    c.else_();
    this.deps.boxBytes(c, (cc) => this.deps.pushBytesPayload(cc, (ccc) => ccc.localGet(chunkLocal)));
    c.end();
  }

  /** `(root) -> void` — if a `nextChunkDyn` continuation is parked
   * (RS_WAITER), decide whether it can settle NOW: already-buffered
   * content (an ordinary whole-buffer `read()`, absent n — 1746's
   * "buffered content delivers concatenated" pin, the SAME absent-read
   * path a bare `for await` in Node itself takes) settles fulfilled with
   * the boxed chunk; an observed RS_ERROR settles rejected with it
   * (`errPreOf` restores the dynamic class a `catch (e) { e instanceof
   * Error }` needs). "Nothing left to give" SPLITS in two (STAGE D P4,
   * rider #72's mechanism 2): cleanly ended-and-drained settles fulfilled
   * with the dyn `undefined` EOF sentinel (Node-exact, unchanged); a
   * no-error destroy that did NOT reach that clean end — the
   * hang-avoidance fallback RS_WAITER's own header names, now including
   * rider #72's own destroy-on-early-exit path — instead settles
   * REJECTED with an AbortError (name/code/message measured directly
   * against Node, buildCheckWaiterCore's own comment has the full
   * matrix). Otherwise leaves it parked; a no-op when nothing is parked
   * at all. */
  private checkWaiterCore(): number {
    // cachedRecursive, NOT plain cached: checkWaiterCore -> readCore ->
    // callRead -> destroyErrCore -> checkWaiterCore is a genuine cycle
    // back to ITSELF (not just through destroyErrCore) — whichever of
    // the two functions some caller reaches FIRST would otherwise still
    // be mid-build (no cache entry yet) when the cycle loops back to it.
    // Both ends of the cycle need the reserve-before-build discipline;
    // see destroyErrCore's own comment for the general hazard.
    return this.cachedRecursive(
      "checkWaiterCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.rs.checkWaiter"),
      (idx) => this.buildCheckWaiterCore(idx),
    );
  }

  private buildCheckWaiterCore(idx: number): void {
    const c = new Code();
    const ROOT = 0, ST = 1, W = 2, CHUNK = 3, ERR = 4;
    const clearAndReturn = (): void => {
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_CHECKING_WAITER);
      c.return_();
    };
    c.localGet(ROOT);
    c.call(this.stateEnsure());
    c.localSet(ST);
    // RS_CHECKING_WAITER's own header: a reentrancy guard, found via
    // execution (a genuine stack overflow, not review) — readCore below
    // may call back into THIS function through callRead -> a user/
    // fromArr `_read` -> push()'s own tail. Every reentrant call becomes
    // a no-op; the outermost call still settles correctly once its own
    // (possibly reentrantly-populated) readCore call returns.
    c.localGet(ST);
    c.structGet(this.stateT(), RS_CHECKING_WAITER);
    c.ifVoid();
    c.return_();
    c.end();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_WAITER);
    c.refIsNull();
    c.ifVoid();
    c.return_();
    c.end();
    c.localGet(ST);
    c.i32Const(1);
    c.structSet(this.stateT(), RS_CHECKING_WAITER);
    c.localGet(ROOT);
    c.f64Const(NaN);
    c.i32Const(1);
    c.call(this.readCore());
    c.localSet(CHUNK);
    c.localGet(CHUNK);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_WAITER);
    c.refAsNonNull();
    c.localSet(W);
    c.localGet(ST);
    c.refNull(this.promType());
    c.structSet(this.stateT(), RS_WAITER);
    c.localGet(W);
    c.i32Const(this.deps.excTag.ref);
    c.f64Const(0);
    this.emitBoxChunkAsDyn(c, ST, CHUNK);
    c.i32Const(-1);
    c.i32Const(1);
    c.call(this.deps.promSettle());
    clearAndReturn();
    c.end();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_ERROR);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_WAITER);
    c.refAsNonNull();
    c.localSet(W);
    c.localGet(ST);
    c.refNull(this.promType());
    c.structSet(this.stateT(), RS_WAITER);
    c.localGet(W);
    c.i32Const(this.deps.excTag.obj);
    c.f64Const(0);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_ERROR);
    this.deps.errPreOf(c, (cc) => {
      cc.localGet(ST);
      cc.structGet(this.stateT(), RS_ERROR);
    });
    c.i32Const(2);
    c.call(this.deps.promSettle());
    clearAndReturn();
    c.end();
    // Two DIFFERENT "nothing left to give" shapes, SPLIT (STAGE D P4,
    // rider #72's mechanism 2 — CORRECTED design, after a lead-caught
    // STOP-class review round: the first draft rejected EVERY destroyed-
    // no-error stream with an AbortError uniformly, which is wrong for
    // this branch specifically — measured directly against Node, an
    // EXTERNALLY destroyed stream (no for-await abort involved at all —
    // a plain `.destroy()` call, checked both while a loop is parked
    // AND before any loop starts) throws ERR_STREAM_PREMATURE_CLOSE, not
    // AbortError; only re-iterating a stream a PRIOR for-await loop's own
    // break destroyed throws AbortError. That AbortError shape does NOT
    // reach this branch at all any more: destroyAbortedCore (the
    // synthetic finally's own libCall, stream.destroyAborted) stores the
    // AbortError directly into RS_ERROR before ever parking a NEW waiter,
    // so a fresh for-await's own nextChunkDynCore->checkWaiterCore call
    // hits the EXISTING RS_ERROR-is-set branch above unchanged — no
    // provenance tracking needed for that half after all, exactly as
    // hypothesized and then confirmed: Node's real async-iterator break-
    // destroy substitutes a synthesized AbortError as the stream's OWN
    // error (measured: `stream.errored` reads it immediately after
    // break, and a real attached 'error' listener fires with it).
    // Cleanly ended-and-drained still settles FULFILLED with the EOF
    // sentinel (Node really does complete silently there, unchanged).
    // Destroyed with NO error and WITHOUT having reached that clean end
    // — an external `.destroy()` with nothing else watching, parked or
    // not — now REJECTS with Node's own ERR_STREAM_PREMATURE_CLOSE
    // shape (name "Error", code "ERR_STREAM_PREMATURE_CLOSE", message
    // "Premature close" — settleConsumerCore's own literal, reused
    // verbatim: the stream/consumers path already builds this exact
    // shape for the identical stream state, confirmed by reading the
    // source, not assumed). destroy(err) is untouched by this split —
    // that's the RS_ERROR-is-set branch above, already correct (Node
    // just rethrows the given error verbatim; 1746's own "mid-iter" pin
    // already covers it).
    //
    // RS_END_EMITTED, NOT RS_ENDED (found via execution — a real
    // ordering bug, not a review catch): RS_ENDED flips synchronously
    // the moment push(null) runs, long before 'end' actually fires or
    // autoDestroy runs — this VERY readCore call above may itself have
    // just SCHEDULED the OP_END tick (endReadableCore's own doing,
    // unrelated to this pass) without having run it yet. Settling here
    // on RS_ENDED would resolve the for-await loop's `undefined` sentinel
    // BEFORE readableEnded/destroyed actually flip, so a synchronous
    // `for await` loop, then `console.log(r.readableEnded, r.destroyed)`
    // right after with no intervening await (1746's own "after:" pin)
    // would observe stale false/false. RS_END_EMITTED only becomes true
    // INSIDE opEnd(), which (this pass's own wiring) already calls this
    // same function again right after — so waiting for that call is what
    // makes the settle observably correct, at the cost of one extra tick
    // versus Node's own timing (unverified against Node's own tick-count
    // for this corner; only the OBSERVABLE per-claim ordering is pinned).
    c.localGet(ST);
    c.structGet(this.stateT(), RS_END_EMITTED);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_LENGTH);
    c.f64Const(0);
    c.f64Eq();
    c.i32And();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_WAITER);
    c.refAsNonNull();
    c.localSet(W);
    c.localGet(ST);
    c.refNull(this.promType());
    c.structSet(this.stateT(), RS_WAITER);
    c.localGet(W);
    c.i32Const(this.deps.excTag.ref);
    c.f64Const(0);
    c.globalGet(this.deps.undefinedDynGlobal());
    c.i32Const(-1);
    c.i32Const(1);
    c.call(this.deps.promSettle());
    c.else_();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_DESTROYED);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_ERROR);
    c.refIsNull();
    c.i32And();
    c.ifVoid();
    c.localGet(ST);
    c.structGet(this.stateT(), RS_WAITER);
    c.refAsNonNull();
    c.localSet(W);
    c.localGet(ST);
    c.refNull(this.promType());
    c.structSet(this.stateT(), RS_WAITER);
    this.deps.buildErrorLit(
      c,
      "%Error",
      "Error",
      (cc) => this.deps.lit(cc, "Premature close"),
      "ERR_STREAM_PREMATURE_CLOSE",
    );
    c.localSet(ERR);
    c.localGet(W);
    c.i32Const(this.deps.excTag.obj);
    c.f64Const(0);
    c.localGet(ERR);
    this.deps.errPreOf(c, (cc) => cc.localGet(ERR));
    c.i32Const(2);
    c.call(this.deps.promSettle());
    c.end();
    c.end();
    clearAndReturn();
    this.mb.setBody(
      idx,
      [this.stateRef(), this.deps.promRef(), this.deps.bytesRef(), this.deps.errRef()],
      c.bytes(),
    );
  }

  /** `(root) -> promise<dyn>` — `readable.nextChunkDyn`, the for-await
   * surface (lowerForAwaitReadable's own header — the typed
   * `nextChunk` is frontend dead code, per pass 1's finding restated in
   * the increment's task brief). Always mints a FRESH promise and parks
   * it in RS_WAITER, then immediately asks `checkWaiterCore` to settle
   * it if it already can (data already buffered, already errored,
   * already ended-and-empty) — a fresh mint rather than a fast-path
   * short-circuit keeps this ONE code path for both the "already
   * available" and "must wait" cases, matching Node's own promise
   * subscribe (promises.ts's header: "EVERY AWAIT SPENDS A TURN" — an
   * immediately-settled promise still costs the awaiting frame exactly
   * one microtask turn, never an inline fast path). */
  nextChunkDynCore(): number {
    return this.cached("nextChunkDynCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.deps.promRef()]), "%w.rs.nextChunkDyn");
      const c = new Code();
      const ROOT = 0, ST = 1, P = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // FIX ROUND (gate finding 5, S049): a SECOND outstanding
      // nextChunkDyn while one is already parked would silently
      // overwrite RS_WAITER, abandoning the first promise unsettled —
      // measured user-visible result: a concurrent-for-await program
      // printed truncated output and exited 0. Node CHAINS here (both
      // loops share one cached async iterator); this tier does not
      // build that machinery — trap LOUDLY instead of truncating
      // silently (S049 registers the divergence).
      c.localGet(ST);
      c.structGet(this.stateT(), RS_WAITER);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.call(this.deps.promMint());
      c.localSet(P);
      c.localGet(ST);
      c.localGet(P);
      c.structSet(this.stateT(), RS_WAITER);
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      c.localGet(P);
      this.mb.setBody(idx, [this.stateRef(), this.deps.promRef()], c.bytes());
      return idx;
    });
  }

  /* ── PASS 2: Readable.from(array) ──────────────────────────────────────
   * A REAL lazy `_read`, reusing pass 1's own underscore-override slots
   * (RS_READ_CLOS/RS_READ_THUNK) with a synthetic closure this file
   * builds itself, rather than eager-pushing every element at
   * construction — MEASURED necessary directly (two live Node probes,
   * chunking.mjs): a plain Readable with pre-buffered chunks MERGES them
   * under a bare `for await`'s absent-n read() (howMuchToRead's
   * not-flowing whole-buffer branch), but `Readable.from([Buffer,
   * Buffer])` does NOT — only ONE array element is EVER buffered at
   * read() time in real Node, because `_read` pulls exactly one per
   * cycle. Reusing the existing RS_READ_CLOS/RS_READ_THUNK protocol
   * (rather than inventing a parallel one, cf. RS_ENCODING's chunk-list
   * reuse above) means every OTHER piece of this file — read/flow/pause/
   * resume/destroy — needs zero changes to serve a from()'d stream. */

  // %w.rs.fromArrClos's field indices — one per element-kind struct
  // (interned separately per `strings`, since the vec type itself
  // differs), same two fields either way.
  private static readonly FAC_VEC = 0;
  private static readonly FAC_IDX = 1;

  private fromArrClosT(strings: boolean): number {
    return this.cached(`fromArrClosT:${strings}`, () => {
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.vecStruct(strings) };
      return this.mb.structType([
        { storage: vecRef, mutable: false }, // FAC_VEC
        { storage: I32, mutable: true }, // FAC_IDX
      ]);
    });
  }

  /** `readThunkSig`-shaped: `(clos: eq, this: root, size: f64) -> void`.
   * Pushes array[idx] (one whole element — Node's own "one chunk per
   * array element" special case, already the ONLY shape `readable.
   * fromArr` is called with: `Readable.from(str)`/`Readable.from(buf)`
   * arrive here pre-wrapped as a one-element array by lower-stream.ts
   * itself, so this function needs no separate single-value path) and
   * advances the index, or push(null) once exhausted. */
  private fromArrReadThunk(strings: boolean): number {
    return this.cached(`fromArrReadThunk:${strings}`, () => {
      const idx = this.mb.declareFunc(this.readThunkSig(), `%w.rs.fromArrRead:${strings ? "str" : "bytes"}`);
      const c = new Code();
      const CLOS = 0, ROOT = 1, SIZE = 2, CL = 3, N = 4, I = 5, ELEM = 6;
      const closT = this.fromArrClosT(strings);
      const vecStructT = this.deps.vecStruct(strings);
      const vecBufT = this.deps.vecBufType(strings);
      c.localGet(CLOS);
      c.refCast(closT);
      c.localSet(CL);
      c.localGet(CL);
      c.structGet(closT, StreamBuilder.FAC_VEC);
      c.refAsNonNull();
      c.structGet(vecStructT, LEN);
      c.localSet(N);
      c.localGet(CL);
      c.structGet(closT, StreamBuilder.FAC_IDX);
      c.localSet(I);
      c.localGet(I);
      c.localGet(N);
      c.i32LtS();
      c.ifVoid();
      c.localGet(CL);
      c.structGet(closT, StreamBuilder.FAC_VEC);
      c.refAsNonNull();
      c.structGet(vecStructT, BUF);
      c.localGet(I);
      c.arrayGet(vecBufT);
      c.refAsNonNull();
      c.localSet(ELEM);
      c.localGet(ROOT);
      c.localGet(ELEM);
      c.i32Const(0); // front
      c.call(strings ? this.pushStrCore() : this.pushCore());
      c.drop();
      c.localGet(CL);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.structSet(closT, StreamBuilder.FAC_IDX);
      c.else_();
      c.localGet(ROOT);
      c.call(this.pushNullCore());
      c.drop();
      c.end();
      this.mb.setBody(
        idx,
        [{ kind: "ref", nullable: true, typeIndex: closT }, I32, I32, this.deps.vecElemVal(strings)],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(vec, front-facing) -> root` — `readable.fromArr`: a fresh
   * %Readable over the DEFAULT construction options (hwm 65536,
   * autoDestroy/emitClose true — `Readable.from` takes no options
   * object), its `_read` wired to `fromArrReadThunk` via a freshly built
   * closure `{vec, idx:0}`. The RECEIVER (the fresh instance) is built
   * by the emitter's own allocation dance (classInfo/emitAlloc — the
   * SAME one `readable.new` uses), not here — this function starts from
   * an ALREADY-ALLOCATED, state-ensured root, mirroring `readable.init`'s
   * own split. */
  fromArrCore(strings: boolean): number {
    return this.cached(`fromArrCore:${strings}`, () => {
      const root = this.deps.rootRef();
      const vecRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.vecStruct(strings) };
      const idx = this.mb.declareFunc(
        this.mb.funcType([root, vecRef], []),
        `%w.rs.fromArr:${strings ? "str" : "bytes"}`,
      );
      const c = new Code();
      const ROOT = 0, VEC = 1, ST = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      // Node's real `Readable.from`: always `{objectMode:true,
      // highWaterMark:1}` regardless of source, oracle-measured (this
      // file's RS_OBJECT_MODE header has the full rationale + the scoped-
      // safety argument for why this tier's byte/char-length hwm
      // machinery does not need object-mode's real count-by-entry
      // semantics to answer this correctly for for-await consumption).
      c.f64Const(1);
      c.structSet(this.stateT(), RS_HWM);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_OBJECT_MODE);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_AUTO_DESTROY);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMIT_CLOSE);
      // STAGE D: RS_SIDES — Readable.from always produces a readable-only
      // object (Node's own contract; RS_SIDES's own header). fromArrCore
      // mints its OWN state directly (never routes through readable.new's
      // emitter.ts block), so it needs this stamp too.
      c.localGet(ST);
      c.i32Const(FIN_SIDE_R);
      c.structSet(this.stateT(), RS_SIDES);
      c.localGet(ST);
      c.localGet(VEC);
      c.i32Const(0);
      c.structNew(this.fromArrClosT(strings));
      c.structSet(this.stateT(), RS_READ_CLOS);
      c.localGet(ST);
      this.mb.declareFuncRef(this.fromArrReadThunk(strings));
      c.refFunc(this.fromArrReadThunk(strings));
      c.structSet(this.stateT(), RS_READ_THUNK);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /* ── pause / resume / unshift ─────────────────────────────────────── */

  /** `(root) -> void` — flips to paused and fires 'pause' SYNCHRONOUSLY
   * (Node's own sync/tick split — only when actually transitioning away
   * from flowing/unset, matching `flowing !== false`). */
  pauseCore(): number {
    return this.cached("pauseCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.pause");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_FLOWING);
      this.emitNoArgFrom(c, ROOT, "pause", ARGS);
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — flips to flowing and schedules the 'resume' tick
   * once (collapsed via `resume_scheduled`, matching `!flowing`). */
  resumeCore(): number {
    return this.cached("resumeCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.resume");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_FLOWING);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_RESUME_SCHEDULED);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_RESUME_SCHEDULED);
      c.localGet(ROOT);
      c.i32Const(OP_RESUME);
      c.call(this.scheduleTick());
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /* ── pipe() (STAGE C PASS 2) ──────────────────────────────────────── */

  /** pipe()'s own shared closure shape — one instance per pipe() call,
   * referenced by all three internal listeners (ondata/ondrain/onend);
   * each routes to different behavior through its OWN thunk, not a
   * different closure. Keyed (not shape-interned): a coincidental match
   * with some unrelated two-root-ref struct elsewhere must never alias. */
  private pipeClosT(): number {
    if (this.pipeClosTField !== null) return this.pipeClosTField;
    const root = this.deps.rootRef();
    this.pipeClosTField = this.mb.openStructType("stream.pipeClos", [
      { storage: root, mutable: false }, // PIPE_SRC
      { storage: root, mutable: false }, // PIPE_DST
    ]);
    return this.pipeClosTField;
  }

  private pipeClosRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.pipeClosT() };
  }

  /** `(dyn) -> bytes` — Node forwards whatever 'data' delivers to
   * `dest.write()` unchanged; this tier's chunk list is always bytes
   * internally, but the DYN box a 'data' emission builds is bytes-kind
   * normally and STR-kind when the source is `setEncoding`'d (1744's own
   * shape: an encoded source still piping bytes-exactly into a
   * Writable) — re-encode a STR-kind chunk back rather than assuming
   * BYTES (which would `bytesPayloadBytes`'s own ref.cast trap on it). */
  private chunkDynToBytesCore(): number {
    return this.cached("chunkDynToBytesCore", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.dynRef()], [this.deps.bytesRef()]), "%w.rs.chunkDynToBytes");
      const c = new Code();
      const D = 0;
      c.localGet(D);
      c.structGet(this.deps.dynT(), DYN_KIND);
      c.i32Const(DK.STR);
      c.i32Eq();
      c.ifResult(this.deps.bytesRef());
      c.localGet(D);
      c.structGet(this.deps.dynT(), DYN_REF);
      c.refCast(this.deps.strType());
      c.call(this.deps.bytesFromStrUtf8());
      c.else_();
      this.deps.bytesPayloadBytes(c, (cc) => cc.localGet(D));
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** pipe()'s 'data' listener thunk (events.ts's uniform `(clos: eq,
   * args: dynArr) -> dyn`): `dest.write(chunk)`; a false return pauses
   * the source (Node's own `ondata`/backpressure pair, 1693's shape). */
  private pipeOndataThunk(): number {
    return this.cached("pipeOndataThunk", () => {
      const idx = this.mb.declareFunc(this.deps.thunkSig(), "%w.rs.pipeOndata");
      const c = new Code();
      const CLOS = 0, ARGS = 1, CL = 2, CHUNK = 3, BYTES = 4, RETB = 5;
      c.localGet(CLOS);
      c.refCast(this.pipeClosT());
      c.localSet(CL);
      c.localGet(ARGS);
      c.structGet(this.deps.dynArrStructType(), BUF);
      c.i32Const(0);
      c.arrayGet(this.deps.dynArrBufType());
      c.localSet(CHUNK);
      c.localGet(CHUNK);
      c.call(this.chunkDynToBytesCore());
      c.localSet(BYTES);
      c.localGet(CL);
      c.structGet(this.pipeClosT(), PIPE_DST);
      c.localGet(BYTES);
      c.refNull(this.deps.voidClos().clos);
      c.call(this.writeCore());
      c.localSet(RETB);
      c.localGet(RETB);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(CL);
      c.structGet(this.pipeClosT(), PIPE_SRC);
      c.call(this.pauseCore());
      c.end();
      c.globalGet(this.deps.undefinedDynGlobal());
      this.mb.setBody(idx, [this.pipeClosRef(), this.deps.dynRef(), this.deps.bytesRef(), I32], c.bytes());
      return idx;
    });
  }

  /** pipe()'s 'drain' listener thunk on the DESTINATION: resumes the
   * SOURCE (Node's own `ondrain`). Zero-arg in spirit (drain carries no
   * payload); the uniform thunk sig still takes the args vector, unread. */
  private pipeOndrainThunk(): number {
    return this.cached("pipeOndrainThunk", () => {
      const idx = this.mb.declareFunc(this.deps.thunkSig(), "%w.rs.pipeOndrain");
      const c = new Code();
      const CLOS = 0, CL = 2;
      c.localGet(CLOS);
      c.refCast(this.pipeClosT());
      c.localSet(CL);
      c.localGet(CL);
      c.structGet(this.pipeClosT(), PIPE_SRC);
      c.call(this.resumeCore());
      c.globalGet(this.deps.undefinedDynGlobal());
      this.mb.setBody(idx, [this.pipeClosRef()], c.bytes());
      return idx;
    });
  }

  /** pipe()'s 'end' listener thunk on the SOURCE (registered `once`):
   * `dest.end()` (Node's own `onend`, gated by the `{end}` option at the
   * REGISTRATION site — this thunk itself is only ever wired up when
   * pipe()'s own `end` argument is true). */
  private pipeOnendThunk(): number {
    return this.cached("pipeOnendThunk", () => {
      const idx = this.mb.declareFunc(this.deps.thunkSig(), "%w.rs.pipeOnend");
      const c = new Code();
      const CLOS = 0, CL = 2;
      c.localGet(CLOS);
      c.refCast(this.pipeClosT());
      c.localSet(CL);
      c.localGet(CL);
      c.structGet(this.pipeClosT(), PIPE_DST);
      c.refNull(this.deps.bytesStructType());
      c.i32Const(0); // hasChunk
      c.refNull(this.deps.voidClos().clos);
      c.i32Const(0); // hasCb
      c.call(this.endCore());
      c.globalGet(this.deps.undefinedDynGlobal());
      this.mb.setBody(idx, [this.pipeClosRef()], c.bytes());
      return idx;
    });
  }

  /** `(root: src, dst, endFlag) -> root` — `pipe()` itself: registers the
   * shared closure's three internal listeners, emits 'pipe' on `dst`
   * synchronously (Node's own order — before the first byte can flow),
   * and returns `dst` (Node's `pipe()` return value, lower-stream.ts's
   * own `type: dst.type`). S050 (registered before this landed): a
   * SECOND simultaneous pipe destination TRAPS rather than silently
   * overwriting or fanning out — this tier tracks one relationship per
   * source, by construction. */
  pipeCore(): number {
    return this.cachedRecursive(
      "pipeCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.rootRef(), I32], [this.deps.rootRef()]), "%w.rs.pipe"),
      (idx) => {
        this.mb.declareFuncRef(this.pipeOndataThunk());
        this.mb.declareFuncRef(this.pipeOndrainThunk());
        this.mb.declareFuncRef(this.pipeOnendThunk());
        const c = new Code();
        const ROOT = 0, DST = 1, ENDFLAG = 2, ST = 3, CLOS = 4, ARGS = 5;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_DEST);
        c.refIsNull();
        c.i32Eqz();
        c.ifResult(this.deps.rootRef());
        // S050: already piping — loud named trap, not a silent overwrite.
        this.deps.setUncaughtError(c, (cc) => {
          this.deps.buildErrorLit(
            cc,
            "%Error",
            "Error",
            (ccc) => this.deps.lit(ccc, "multiple simultaneous pipe() destinations are not supported yet (SEMANTICS.md S050)"),
            null,
          );
        });
        c.localGet(DST);
        c.else_();
        c.localGet(ROOT);
        c.localGet(DST);
        c.structNew(this.pipeClosT());
        c.localSet(CLOS);
        c.localGet(ST);
        c.localGet(DST);
        c.structSet(this.stateT(), RS_PIPE_DEST);
        // 'data' on the source.
        c.localGet(ROOT);
        this.deps.lit(c, "data");
        c.localGet(CLOS);
        c.refFunc(this.pipeOndataThunk());
        c.localGet(CLOS);
        c.i32Const(0); // once
        c.i32Const(0); // prepend
        c.call(this.deps.entryAppend());
        c.localGet(ST);
        c.localGet(CLOS);
        c.structSet(this.stateT(), RS_PIPE_ONDATA);
        // Registering 'data' directly via entryAppend (not the frontend's
        // own `.on('data', cb)` dispatch) bypasses the hook that call
        // site normally fires afterward — replicate it explicitly:
        // Node's real pipe() calls `src.resume()` itself (this IS that
        // call, `onDataAdded`'s own "auto-resume unless explicitly
        // paused" gate already matching Node's `flowing !== false`).
        c.localGet(ROOT);
        c.call(this.onDataAdded());
        // 'drain' on the destination.
        c.localGet(DST);
        this.deps.lit(c, "drain");
        c.localGet(CLOS);
        c.refFunc(this.pipeOndrainThunk());
        c.localGet(CLOS);
        c.i32Const(0);
        c.i32Const(0);
        c.call(this.deps.entryAppend());
        c.localGet(ST);
        c.localGet(CLOS);
        c.structSet(this.stateT(), RS_PIPE_ONDRAIN);
        // 'end' on the source, ONCE — only when the caller asked for it
        // (the default; lower-stream.ts's own `end` argument, always a
        // compile-time literal per its lowering — a literal `false`
        // refuses at the emitter dispatch site, never reaches here).
        c.localGet(ENDFLAG);
        c.ifVoid();
        c.localGet(ROOT);
        this.deps.lit(c, "end");
        c.localGet(CLOS);
        c.refFunc(this.pipeOnendThunk());
        c.localGet(CLOS);
        c.i32Const(1); // once
        c.i32Const(0);
        c.call(this.deps.entryAppend());
        c.localGet(ST);
        c.localGet(CLOS);
        c.structSet(this.stateT(), RS_PIPE_ONEND);
        c.end();
        // 'pipe' on the destination — synchronous, zero-arg (the file
        // header's own scoped-down decision: no existing primitive boxes
        // a class instance into dyn, and no claim this pass reads the
        // argument — see the pipe design report for the measured sibling
        // evidence).
        this.emitNoArgFrom(c, DST, "pipe", ARGS);
        c.localGet(DST);
        c.end();
        this.mb.setBody(idx, [this.stateRef(), this.pipeClosRef(), this.deps.dynArrRef()], c.bytes());
      },
    );
  }

  /** `(root: src, dst: root|null, hasDst) -> root` — `unpipe()`: removes
   * the three listeners BY IDENTITY (events.ts's `removeLast`, Node's own
   * mechanism), emits 'unpipe' on the destination, and clears the pipe
   * state — a no-op when not currently piping, or when `dst` is given
   * and does not match the active destination (Node's own semantics: an
   * unpipe naming an uninvolved stream does nothing). Always returns
   * `src` (lower-stream.ts's own `type: receiver.type`). */
  unpipeCore(): number {
    return this.cachedRecursive(
      "unpipeCore",
      () =>
        this.mb.declareFunc(
          this.mb.funcType([this.deps.rootRef(), this.deps.rootRef(), I32], [this.deps.rootRef()]),
          "%w.rs.unpipe",
        ),
      (idx) => {
        const c = new Code();
        const ROOT = 0, DST = 1, HASDST = 2, ST = 3, DSTVAL = 4, ARGS = 5;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_DEST);
        c.refIsNull();
        c.i32Eqz(); // is piping
        c.localGet(HASDST);
        c.i32Eqz(); // no dst arg given -> always matches
        c.localGet(HASDST);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_DEST);
        c.localGet(DST);
        c.refEq();
        c.i32And(); // has dst arg AND it matches
        c.i32Or();
        c.i32And(); // is-piping AND (no-arg OR matches)
        c.ifVoid();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_DEST);
        c.localSet(DSTVAL);
        c.localGet(ROOT);
        this.deps.lit(c, "data");
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_ONDATA);
        c.call(this.deps.removeLast());
        c.localGet(DSTVAL);
        this.deps.lit(c, "drain");
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_ONDRAIN);
        c.call(this.deps.removeLast());
        // RS_PIPE_ONEND may be null (endFlag was false at pipe() time, or
        // it already self-removed via its own `once`) — removeLast's own
        // no-match-is-a-no-op contract (its header) makes this safe
        // unconditionally, no extra null check needed.
        c.localGet(ROOT);
        this.deps.lit(c, "end");
        c.localGet(ST);
        c.structGet(this.stateT(), RS_PIPE_ONEND);
        c.call(this.deps.removeLast());
        this.emitNoArgFrom(c, DSTVAL, "unpipe", ARGS);
        c.localGet(ST);
        c.refNull(this.deps.rootStruct());
        c.structSet(this.stateT(), RS_PIPE_DEST);
        c.localGet(ST);
        c.refNull(EQ_HEAP);
        c.structSet(this.stateT(), RS_PIPE_ONDATA);
        c.localGet(ST);
        c.refNull(EQ_HEAP);
        c.structSet(this.stateT(), RS_PIPE_ONDRAIN);
        c.localGet(ST);
        c.refNull(EQ_HEAP);
        c.structSet(this.stateT(), RS_PIPE_ONEND);
        c.end();
        c.localGet(ROOT);
        this.mb.setBody(idx, [this.stateRef(), this.deps.rootRef(), this.deps.dynArrRef()], c.bytes());
      },
    );
  }

  /** `(root) -> void` — the `.on('data', cb)` side effect (Node's
   * `Readable.prototype.on` override): auto-resumes UNLESS the stream is
   * explicitly paused (`flowing === false` exactly — an unset/-1 stream
   * still auto-resumes, matching `flowing !== false`). */
  onDataAdded(): number {
    return this.cached("onDataAdded", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.onDataAdded");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Ne();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.resumeCore());
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — the `.on('readable', cb)` side effect: arms
   * `needReadable`/`readableListening`, forces paused mode, and either
   * schedules the collapsed 'readable' tick (content already buffered)
   * or opportunistically primes `_read` (nothing buffered yet) —
   * ONE-TIME (`readableListening` guards re-entry on a second
   * registration, and `endEmitted` on a stream that already finished). */
  onReadableAdded(): number {
    return this.cached("onReadableAdded", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.onReadableAdded");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READABLE_LISTENING);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_READABLE_LISTENING);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_FLOWING);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.localGet(ROOT);
      c.i32Const(OP_READABLE);
      c.call(this.scheduleTick());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      // Node's real `nReadingNextTick` (2572's fix): a SCHEDULED
      // `stream.read(0)`, not a synchronous call here — a same-turn
      // synchronous `read(0)` would clear `sync` (via `callRead`'s own
      // bracket) before a later-in-the-SAME-turn `push(null)` runs,
      // flipping `onEofChunk`'s sync-vs-direct branch and producing an
      // extra 'readable' cycle Node never fires (opPrimeRead's header).
      c.localGet(ROOT);
      c.i32Const(OP_PRIME_READ);
      c.call(this.scheduleTick());
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `isPaused()`: `flowing === false` exactly (NOT
   * "not flowing" — the unset/-1 state answers false too, matching
   * Node's `state.flowing === false`). */
  isPausedCore(): number {
    return this.cached("isPausedCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.isPaused");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(0);
      c.i32Eq();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── destroy ───────────────────────────────────────────────────────── */

  /** `(root, err: errRef|null) -> void` — `destroy()`'s ONE entry point,
   * every caller's (STAGE C: now gates on a user `_destroy` override
   * FIRST — the NO-OVERRIDE default path this was pass 1's whole scope
   * moved into `destroyErrDefaultCore` below, called directly here when
   * no override exists, or from the override's own done-closure landing
   * site otherwise): idempotent (`destroyed` guards the whole function,
   * matching Node's `if (state.destroyed) return`, and is set BEFORE
   * dispatching to an override — Node's own `destroy()` order). */
  destroyErrCore(): number {
    // PASS 2: cachedRecursive, NOT plain cached — this function's own
    // body now reaches checkWaiterCore -> readCore -> callRead ->
    // destroyErrCore again (a genuinely NEW cycle pass 1 never had:
    // destroy() used to touch only stateEnsure/scheduleTick). scheduleTick
    // /dispatchOne's own header explains the exact hazard a plain
    // `cached` has here (the reentrant call recurses into building a
    // SECOND copy forever since the map isn't populated until `build`
    // returns) — reserving the index before building the body breaks it.
    return this.cachedRecursive(
      "destroyErrCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.errRef()], []), "%w.rs.destroyErr"),
      (idx) => this.buildDestroyErrCore(idx),
    );
  }

  private buildDestroyErrCore(idx: number): void {
    const c = new Code();
    const ROOT = 0, ERR = 1, ST = 2, NEWERR = 3;
    c.localGet(ROOT);
    c.call(this.stateEnsure());
    c.localSet(ST);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_DESTROYED);
    c.ifVoid();
    c.return_();
    c.end();
    c.localGet(ST);
    c.i32Const(1);
    c.structSet(this.stateT(), RS_DESTROYED);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_DESTROY_CLOS);
    c.refIsNull();
    c.ifVoid();
    c.localGet(ROOT);
    c.localGet(ERR);
    c.call(this.destroyErrDefaultCore());
    c.else_();
    // call_ref wants [args..., funcref] — the closure itself, `this`,
    // the error, THEN the funcref last (the adapter builds ITS OWN
    // done-closure from `this` and calls the user's `_destroy`).
    c.localGet(ST);
    c.structGet(this.stateT(), RS_DESTROY_CLOS);
    c.localGet(ROOT);
    c.localGet(ERR);
    c.localGet(ST);
    c.structGet(this.stateT(), RS_DESTROY_THUNK);
    c.callRef(this.destroyThunkSig());
    // GATE FIX (pending-check audit, destroy-side — d13c-sync-throw-
    // destroy.cjs, measured BEFORE wiring). Node's real internal
    // `_destroy` (internal/streams/destroy.js) wraps `stream._destroy()`
    // in a try/catch whose catch arm calls the exact same `onDestroy(err)`
    // its own completion-callback argument reaches on a normal call —
    // measured: the resulting 'error' event fires ASYNCHRONOUSLY (a later
    // tick, same as an ordinary destroy error), and an unhandled instance
    // crashes via the standard "Unhandled 'error' event" path, not an
    // immediate synchronous trap — the SAME deferred shape as final's own
    // fix just above, genuinely NOT symmetric with doWriteCore's
    // immediate-crash shape (Node does not wrap `_write` at all). A thunk
    // that throws INSTEAD OF calling its own completion callback needs
    // the identical landing: extract the pending Error-shaped exception
    // and hand it to `destroyErrDefaultCore`, the exact function the
    // done-closure's own landing already calls (this function's own
    // header comment on that function, above).
    this.deps.tryCatchAsError(c);
    c.localSet(NEWERR);
    c.localGet(NEWERR);
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    c.localGet(ROOT);
    c.localGet(NEWERR);
    c.call(this.destroyErrDefaultCore());
    c.end();
    c.end();
    this.mb.setBody(idx, [this.stateRef(), this.deps.errRef()], c.bytes());
  }

  /** `(root, err: errRef|null) -> void` — the NO-USER-`_destroy`-OVERRIDE
   * body (pass 1's original `destroyErrCore`, factored out): schedules
   * 'error' THEN 'close' as two SEPARATE ticks in that order
   * (scr_stream_do_destroy — FIFO dispatch makes 'error' always land
   * before 'close', 1694/1698's pin). Does NOT re-check/re-set
   * `destroyed` — `destroyErrCore` (the gate, above) already did, before
   * ever deciding whether to dispatch to an override, Node's own order.
   * Called directly when no override exists, or from the override's own
   * done-closure landing site (emitter.ts's `doneClosFor`) with
   * whatever error the override's callback actually received — which
   * may differ from (or clear) the error `_destroy` was originally
   * called with, Node's own contract. */
  destroyErrDefaultCore(): number {
    return this.cachedRecursive(
      "destroyErrDefaultCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.errRef()], []), "%w.rs.destroyErrDefault"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ERR = 1, ST = 2;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ST);
        c.localGet(ERR);
        c.structSet(this.stateT(), RS_ERROR);
        c.localGet(ROOT);
        c.i32Const(OP_ERROR);
        c.call(this.scheduleTick());
        c.end();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_EMIT_CLOSE);
        c.ifVoid();
        c.localGet(ROOT);
        c.i32Const(OP_CLOSE);
        c.call(this.scheduleTick());
        c.end();
        // GATE FIX C4 (BLOCKING, measured: c-destroy-cbfate2.cjs / the
        // reviewer's own pinned oracle answer — "_write one / err /
        // close / cb one / cb two"): stop dispatching whatever is still
        // QUEUED (never touch `doWriteCore` again post-destroy — nothing
        // here calls it), and discard the queue STRUCTURALLY now
        // (synchronous — nothing may reach `_write` for a discarded
        // entry even one turn later).
        c.localGet(ROOT);
        c.call(this.discardQueueCore());
        // GATE FIX C4 v2 (BLOCKING, measured: c-destroy-cbfate.ts — Node's
        // real order is "cb one" THEN "cb two", the genuinely in-flight
        // entry's OWN eventual completion callback BEFORE the discarded
        // ones, never an independent earlier tick): only fire
        // OP_FIRE_DISCARDED immediately here when NOTHING was in flight
        // at destroy time (WS_WRITING false — discardQueueCore's own
        // "nothing ever dispatched" branch, nothing to defer for, moved
        // the WHOLE chain into WS_DISCARDED). When something WAS in
        // flight, discardQueueCore kept WS_HEAD as that exact entry and
        // this function must NOT race ahead of its real completion —
        // afterWriteCore's own tail schedules OP_FIRE_DISCARDED itself,
        // once that entry's own callback has already fired (this file's
        // other half of the same fix).
        c.localGet(ST);
        c.structGet(this.stateT(), WS_WRITING);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.i32Const(OP_FIRE_DISCARDED);
        c.call(this.scheduleTick());
        c.end();
        // PASS 2 CORRECTION (found via execution — a real trap, not a
        // review catch): do NOT settle a parked for-await waiter HERE.
        // opError()'s own "is this handled" check reads RS_WAITER!=null
        // to decide whether an error with no real 'error' listener may
        // skip the uncaught-crash path (this file's own opError
        // comment) — if THIS function already rejected and cleared
        // RS_WAITER before OP_ERROR's tick ever runs, opError sees a
        // NULL waiter and wrongly concludes nothing was watching,
        // crashing the program (nexttick.ts's drain loop traps on the
        // resulting uncaught exception). The settle now happens from
        // opError/opClose themselves, AFTER they have already used
        // RS_WAITER's presence to decide they're handled — see those
        // functions' own comments.
        this.mb.setBody(idx, [this.stateRef()], c.bytes());
      },
    );
  }

  /** `(root) -> void` — sets the `_destroy` override/option binding
   * (construction, `stream.setDestroy` underscore-assign). */
  setDestroyCore(): number {
    return this.cached("setDestroyCore", () => {
      const root = this.deps.rootRef();
      const destroyThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.destroyThunkSig() };
      const idx = this.mb.declareFunc(this.mb.funcType([root, EQ_REF, destroyThunkRef], []), "%w.rs.setDestroy");
      const c = new Code();
      const ROOT = 0, CLOS = 1, THUNK = 2, ST = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(CLOS);
      c.structSet(this.stateT(), RS_DESTROY_CLOS);
      c.localGet(ST);
      c.localGet(THUNK);
      c.structSet(this.stateT(), RS_DESTROY_THUNK);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — `destroy()` with no error, destroyErrCore's
   * plain-error-null twin. */
  destroyCore(): number {
    return this.cached("destroyCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.destroy");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.refNull(this.errType());
      c.call(this.destroyErrCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — the synthetic for-await-abort destroy
   * (lowerForAwaitReadable's own finally block, libCall
   * stream.destroyAborted): mirrors Node's real async-iterator break-
   * destroy, which stores a SYNTHESIZED AbortError as the stream's OWN
   * error (measured directly — RS_ERROR_ABORT_SILENT's own header has
   * the full matrix: `stream.errored` reads the AbortError immediately
   * after break, and an attached 'error' listener fires with it, but
   * nothing crashes the process when NOTHING is watching). Builds that
   * AbortError, arms RS_ERROR_ABORT_SILENT so opError's own unhandled-
   * crash fallback stays silent for THIS specific error, then reuses
   * destroyErrCore ENTIRELY — its own RS_DESTROYED idempotent gate, its
   * `_destroy` override dispatch, its OP_CLOSE scheduling, and its
   * OP_ERROR scheduling (which now, thanks to the flag, settles quietly
   * instead of crashing when unhandled) all apply exactly as they do
   * for a user's own destroy(err) call — this function's ENTIRE
   * contribution is "which error, and arm the one flag opError needs
   * to treat it as pre-handled". */
  destroyAbortedCore(): number {
    return this.cached("destroyAbortedCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.destroyAborted");
      const c = new Code();
      const ROOT = 0, ST = 1, ERR = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_ERROR_ABORT_SILENT);
      this.deps.buildErrorLit(
        c,
        "%Error",
        "AbortError",
        (cc) => this.deps.lit(cc, "The operation was aborted"),
        "ABORT_ERR",
      );
      c.localSet(ERR);
      c.localGet(ROOT);
      c.localGet(ERR);
      c.call(this.destroyErrCore());
      this.mb.setBody(idx, [this.stateRef(), this.deps.errRef()], c.bytes());
      return idx;
    });
  }

  /* ── the tick op handlers ─────────────────────────────────────────── */

  /** Emits a NO-ARGUMENT event ('pause'/'resume'/'end'/'close') through
   * events.ts's general dispatch — the same empty-tuple shape the meta
   * events use (events.ts's `fireMetaHelper`, mirrored here for a
   * zero-element tuple instead of a one-string one). */
  private emitNoArgFrom(c: Code, rootLocal: number, name: string, argsScratch: number): void {
    c.i32Const(0); // the dyn-vec's own `len` field, ahead of `buf`
    c.arrayNewFixed(this.deps.dynArrBufType(), 0);
    c.structNew(this.deps.dynArrStructType());
    c.localSet(argsScratch);
    c.localGet(rootLocal);
    this.deps.lit(c, name);
    c.localGet(argsScratch);
    c.call(this.deps.emitDispatch());
    c.drop();
  }

  /** Node's real `emitReadable_` (lift.cjs) — the OP_READABLE tick body,
   * and ALSO called DIRECTLY (a plain function `call`, not through a
   * scheduled tick) from `pushNullCore`'s synchronous EOF branch, the
   * exact dual role the lifted source itself gives this function. Does
   * NOT clear `needReadable` (unlike the prior design) — Node's real
   * function never touches it except the OR-only `need_readable` set
   * near its own end; the CALLER (`scheduleReadable`/`pushNullCore`)
   * clears it before invoking this, matching `emitReadable`/`onEofChunk`
   * exactly. Always calls `flow()` at the end (R4/R5's fix — this is
   * what drains a stream on the EOF path with nothing else consuming). */
  private opReadable(): number {
    return this.cached("opReadable", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opReadable");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.i32And();
      c.ifVoid();
      this.emitNoArgFrom(c, ROOT, "readable", ARGS);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_EMITTED_READABLE);
      c.end();
      // state |= (!(flowing||ended) && length<=hwm) ? needReadable : 0 —
      // OR-only, never clears.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENDED);
      c.i32Or();
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HWM);
      c.f64Le();
      c.i32And();
      c.ifVoid();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_NEED_READABLE);
      c.end();
      c.localGet(ROOT);
      c.call(this.flow());
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  private opResume(): number {
    return this.cached("opResume", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opResume");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.end();
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_RESUME_SCHEDULED);
      this.emitNoArgFrom(c, ROOT, "resume", ARGS);
      c.localGet(ROOT);
      c.call(this.flow());
      c.localGet(ST);
      c.structGet(this.stateT(), RS_FLOWING);
      c.i32Const(1);
      c.i32Eq();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_READING);
      c.i32Eqz();
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.f64Const(0);
      c.i32Const(0);
      c.call(this.readCore());
      c.drop();
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /** CORRECTION (1690, both-sides autoDestroy): `opFinish`'s own header
   * has the full story — this is its mirror-image half. A single-sided
   * Readable destroys immediately once 'end' fires (unchanged); a
   * duplex-shaped stream (WS_DUPLEX_SHAPED) only destroys here once the
   * writable side has ALSO finished (WS_FINISHED) — otherwise `opFinish`
   * (running later) is the one that will.
   *
   * GATE FIX (C2S-1, remedy iteration 3): `allowHalfOpen === false`'s
   * auto-end wiring branches IN PLACE of the autoDestroy check above
   * (OP_AUTO_END's own header has the full mechanism story) — Node's
   * real `endReadableNT` is an if/else-if between the two, never both. */
  private opEnd(): number {
    return this.cached("opEnd", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opEnd");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_END_SCHEDULED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32Eqz();
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.f64Const(0);
      c.f64Gt();
      c.i32Or();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_END_EMITTED);
      this.emitNoArgFrom(c, ROOT, "end", ARGS);
      // GATE FIX (C2S-1, remedy iteration 3 — build the wiring, refuse/
      // trap came back out): branch selection mirroring Node's real
      // `endReadableNT` — `if (stream.writable && allowHalfOpen ===
      // false) { schedule endWritableNT } else if (autoDestroy) { ...
      // existing check, unchanged ... }`. "stream.writable" here is the
      // four-flag guard OP_AUTO_END's own header/body re-checks (state
      // can move in the tick gap between scheduling and firing) —
      // WS_ENDING/WS_ENDED/RS_DESTROYED/RS_ERROR, matching Node's real
      // getter's `kEnding|kEnded|kDestroyed|kErrored` exactly. Measured
      // (not assumed): an explicit end() already called before 'end'
      // fires leaves WS_ENDING set here, correctly falling through to
      // the unchanged autoDestroy branch instead (m3's own probe — no
      // double-end, no error, matching Node's own quiet no-op); a
      // Transform's _flush-driven push(null) can never reach this guard
      // TRUE either, since Transform's readable 'end' is structurally
      // always a downstream consequence of its OWN end() already having
      // been called (m2's own probe — 'finish' here is the ordinary
      // explicit-end sequence, unrelated to this new branch, which never
      // fires for a bare Transform).
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DUPLEX_SHAPED);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ALLOW_HALF_OPEN);
      c.i32Eqz();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDING);
      c.i32Eqz();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDED);
      c.i32Eqz();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Eqz();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.i32Const(OP_AUTO_END);
      c.call(this.scheduleTick());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_AUTO_DESTROY);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DUPLEX_SHAPED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_FINISHED);
      c.i32Or();
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.refNull(this.errType());
      c.call(this.destroyErrCore());
      c.end();
      c.end();
      // PASS 2: covers autoDestroy:false too (destroyErrCore's own call,
      // just above, already does this on the common/default path — a
      // second, idempotent check here since checkWaiterCore no-ops once
      // RS_WAITER is already null).
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  private opError(): number {
    // cachedRecursive: opError -> checkWaiterCore -> readCore -> callRead
    // -> destroyErrCore -> scheduleTick -> dispatchOne -> opError closes
    // the SAME class of build-time cycle destroyErrCore/checkWaiterCore's
    // own comments already document — reserve the index before the body
    // reaches back around.
    return this.cachedRecursive(
      "opError",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.rs.opError"),
      (idx) => this.buildOpError(idx),
    );
  }

  private buildOpError(idx: number): void {
      const c = new Code();
      const ROOT = 0, ST = 1, SILENT = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      // RS_ERROR_EMITTED dropped (the gate round's dead-field instruction
      // — nothing in this file's own scope reads it back; Node's real
      // `errorEmitted` only gates the far-side 'data'/'error' re-entrancy
      // checks this file doesn't model, per readCore's own header note).
      //
      // STAGE D P4: read+clear RS_ERROR_ABORT_SILENT FIRST (single-use,
      // RS_CHECKING_WAITER's own reentrancy-guard idiom — claimed before
      // anything below can observe it) — destroyAbortedCore's own marker
      // that THIS error is the synthesized for-await-abort AbortError,
      // which must join the "handled" set below (RS_ERROR_ABORT_SILENT's
      // own header has the full measured story: Node's real break-
      // destroy never crashes the process from lack of listeners).
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR_ABORT_SILENT);
      c.localSet(SILENT);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_ERROR_ABORT_SILENT);
      c.localGet(ROOT);
      c.call(this.deps.hasErrorListeners());
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.call(this.deps.errDispatch());
      c.else_();
      // PASS 2: an internal watcher (a parked for-await waiter, or an
      // active stream/consumers subscriber) counts as "handled", exactly
      // as Node's OWN internal implementations do (both register a real
      // 'error' listener under the hood) — this tier reproduces the
      // EFFECT (no uncaught-throw crash) without minting a synthetic
      // events.ts entry for it: the error stays pending in RS_ERROR only,
      // picked up by checkWaiterCore/the consumer's own settle at
      // destroyErrCore/opClose (already wired) instead of here. Measured
      // necessary directly: 2630's r1 (destroy(err) with no user 'error'
      // listener, only a pending text() consumer) must reject the
      // promise, not crash the program.
      // STAGE D: a finished()/eos() watcher joins the SAME "handled" set
      // — Node's own eos()/pipeline() internally register a real 'error'
      // listener as a side effect of being called (rD-wasm's own note on
      // this exact gate). The error stays pending in RS_ERROR; FIN_HEAD's
      // own watchers fire later from opClose, same as RS_WAITER/
      // RS_CONSUMER_KIND above — measured necessary directly (2564's r2:
      // destroy(new Error) with only a pending sp.finished promise, no
      // user 'error' listener, must reject the promise, not crash).
      // STAGE D P4: SILENT joins the SAME "handled" set — the for-await
      // abort's own synthesized error, treated as always-handled exactly
      // like Node's internal (unmodeled) eos() listener always is.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_WAITER);
      c.refIsNull();
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_KIND);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), FIN_HEAD);
      c.refIsNull();
      c.i32Eqz();
      c.i32Or();
      c.localGet(SILENT);
      c.i32Or();
      c.ifVoid();
      c.else_();
      this.deps.setUncaughtError(c, (cc) => {
        cc.localGet(ST);
        cc.structGet(this.stateT(), RS_ERROR);
      });
      c.end();
      c.end();
      // NOW settle a parked for-await waiter (destroyErrCore's own
      // comment explains why not from there) — the "is this handled"
      // check just above has already read RS_WAITER's PRE-settle value,
      // so settling here (after) cannot retroactively change that
      // decision.
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      this.mb.setBody(idx, [this.stateRef(), I32], c.bytes());
  }

  /** `(root, kind: i32) -> promise` — `sc.text`/`sc.buffer`/`sc.json`'s
   * shared registration (SC_KIND_*): mint the promise the call answers,
   * arm RS_CONSUMER_*, and drive consumption via the ordinary flowing
   * machinery (`resumeCore`) — accumulation is emitDataFrom's own tee
   * (both the direct-emit and buffered/read paths already flow through
   * it), settlement is opClose's own (below), matching 2629's "resolves
   * after 'close'" timing exactly since nothing here settles early. */
  scRegisterCore(): number {
    return this.cached("scRegisterCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, I32], [this.deps.promRef()]), "%w.rs.scRegister");
      const c = new Code();
      const ROOT = 0, KIND = 1, ST = 2, P = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.call(this.deps.promMint());
      c.localSet(P);
      c.localGet(ST);
      c.localGet(KIND);
      c.structSet(this.stateT(), RS_CONSUMER_KIND);
      c.localGet(ST);
      c.localGet(P);
      c.structSet(this.stateT(), RS_CONSUMER_PROMISE);
      c.localGet(ST);
      c.refNull(this.deps.bytesStructType());
      c.structSet(this.stateT(), RS_CONSUMER_ACC);
      // FIX ROUND (gate finding 6): a consumer registered AFTER opClose
      // has already run has missed the only settle point in the normal
      // order — nothing would ever settle its promise (measured: Node
      // answers text() on an ended-and-closed stream with "" where this
      // tier silently exited 0 with the await never resuming).
      // RS_CLOSE_EMITTED (its header) discriminates exactly that case;
      // every pre-close registration order — including after push(null)
      // but before 'close', 2629 r7/r8's own shape — takes the else arm
      // and behaves exactly as before.
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CLOSE_EMITTED);
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.settleConsumerCore());
      c.else_();
      c.localGet(ROOT);
      c.call(this.resumeCore());
      c.end();
      c.localGet(P);
      this.mb.setBody(idx, [this.stateRef(), this.deps.promRef()], c.bytes());
      return idx;
    });
  }

  private opClose(): number {
    // cachedRecursive — the SAME class of build-time cycle opError's own
    // comment documents (opClose -> checkWaiterCore -> readCore ->
    // callRead -> destroyErrCore -> scheduleTick -> dispatchOne ->
    // opClose).
    return this.cachedRecursive(
      "opClose",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.rs.opClose"),
      (idx) => this.buildOpClose(idx),
    );
  }

  private buildOpClose(idx: number): void {
      const c = new Code();
      const ROOT = 0, ARGS = 1, ST = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      this.emitNoArgFrom(c, ROOT, "close", ARGS);
      // FIX ROUND (gate finding 6): mark close-emitted, then settle any
      // armed consumer via settleConsumerCore — factored out of this
      // function so scRegisterCore can reuse it for a consumer
      // registered AFTER this point (RS_CLOSE_EMITTED's own header).
      // Settling here, after emitNoArgFrom above, preserves 2629's
      // timing pin: the consumer's `.then()` never runs before a user
      // 'close' listener already did, since resolving/rejecting only
      // ENQUEUES the awaiting frame's continuation (promises.ts's
      // "every await spends a turn").
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), RS_CLOSE_EMITTED);
      c.localGet(ROOT);
      c.call(this.settleConsumerCore());
      // STAGE D: fire every finished()/eos() watcher — willEmitClose:true
      // default path (probe13), right after 'close' and RS_CLOSE_EMITTED
      // (FIN_HEAD's own header). Harmless no-op when nothing is parked.
      c.localGet(ROOT);
      c.call(this.fireFinListCore());
      // A parked for-await waiter can ALSO still be here (a bare
      // destroy() with no error never schedules OP_ERROR at all, so
      // opClose is the only tick that ever gets a chance to settle it —
      // this is also a harmless no-op redundant safety net for the
      // error case, since opError's own call already cleared RS_WAITER
      // by the time this runs).
      c.localGet(ROOT);
      c.call(this.checkWaiterCore());
      this.mb.setBody(idx, [this.deps.dynArrRef(), this.stateRef()], c.bytes());
  }

  /** `(root) -> void` — settle an ARMED stream/consumers subscriber
   * (RS_CONSUMER_KIND != 0) from current state: RS_ERROR set -> reject
   * with it; cleanly ended -> transform RS_CONSUMER_ACC per kind;
   * destroyed without ever reaching 'end' -> Node's own
   * ERR_STREAM_PREMATURE_CLOSE (oracle-measured exact shape: name
   * "Error", code "ERR_STREAM_PREMATURE_CLOSE", message "Premature
   * close"). No-op when no consumer is armed. Two callers: opClose (the
   * normal order — settle AFTER 'close' dispatched) and scRegisterCore
   * (late registration on an already-closed stream, gate finding 6).
   * The body is opClose's pass-2 settle block verbatim, only the local
   * indices renumbered. */
  private settleConsumerCore(): number {
    return this.cached("settleConsumerCore", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.rs.settleConsumer");
      const c = new Code();
      const ROOT = 0, ST = 1, KIND = 2, P = 3, BUILTERR = 4, ACC = 5, TMPSTR = 6, DYNRESULT = 7, ERR = 8;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_KIND);
      c.ifVoid();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_KIND);
      c.localSet(KIND);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_PROMISE);
      c.refAsNonNull();
      c.localSet(P);
      c.localGet(ST);
      c.i32Const(0);
      c.structSet(this.stateT(), RS_CONSUMER_KIND);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(P);
      c.i32Const(this.deps.excTag.obj);
      c.f64Const(0);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      this.deps.errPreOf(c, (cc) => {
        cc.localGet(ST);
        cc.structGet(this.stateT(), RS_ERROR);
      });
      c.i32Const(2);
      c.call(this.deps.promSettle());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.ifVoid();
      this.deps.buildErrorLit(c, "%Error", "Error", (cc) => this.deps.lit(cc, "Premature close"), "ERR_STREAM_PREMATURE_CLOSE");
      c.localSet(BUILTERR);
      c.localGet(P);
      c.i32Const(this.deps.excTag.obj);
      c.f64Const(0);
      c.localGet(BUILTERR);
      this.deps.errPreOf(c, (cc) => cc.localGet(BUILTERR));
      c.i32Const(2);
      c.call(this.deps.promSettle());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_ACC);
      c.refIsNull();
      c.ifResult(this.deps.bytesRef());
      c.f64Const(0);
      c.call(this.deps.bytesNewLen());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CONSUMER_ACC);
      c.refAsNonNull();
      c.end();
      c.localSet(ACC);
      c.localGet(KIND);
      c.i32Const(SC_KIND_TEXT);
      c.i32Eq();
      c.ifVoid();
      c.localGet(P);
      c.i32Const(this.deps.excTag.str);
      c.f64Const(0);
      c.localGet(ACC);
      c.call(this.deps.toStrUtf8());
      c.i32Const(-1);
      c.i32Const(1);
      c.call(this.deps.promSettle());
      c.else_();
      c.localGet(KIND);
      c.i32Const(SC_KIND_BUFFER);
      c.i32Eq();
      c.ifVoid();
      c.localGet(P);
      c.i32Const(this.deps.excTag.ref);
      c.f64Const(0);
      c.localGet(ACC);
      c.i32Const(-1);
      c.i32Const(1);
      c.call(this.deps.promSettle());
      c.else_();
      // SC_KIND_JSON, exhaustive: the only remaining SC_KIND_* value.
      c.localGet(ACC);
      c.call(this.deps.toStrUtf8());
      c.localSet(TMPSTR);
      c.localGet(TMPSTR);
      c.call(this.deps.jsonParse());
      c.localSet(DYNRESULT);
      this.deps.tryCatchAsError(c);
      c.localSet(ERR);
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(P);
      c.i32Const(this.deps.excTag.obj);
      c.f64Const(0);
      c.localGet(ERR);
      this.deps.errPreOf(c, (cc) => cc.localGet(ERR));
      c.i32Const(2);
      c.call(this.deps.promSettle());
      c.else_();
      c.localGet(P);
      c.i32Const(this.deps.excTag.ref);
      c.f64Const(0);
      c.localGet(DYNRESULT);
      c.i32Const(-1);
      c.i32Const(1);
      c.call(this.deps.promSettle());
      c.end(); // json-error-vs-ok
      c.end(); // buffer-vs-json
      c.end(); // text-vs-rest
      c.end(); // premature-vs-resolve
      c.end(); // error-vs-rest
      c.end(); // OUTER: has-consumer
      this.mb.setBody(
        idx,
        [
          this.stateRef(), // ST
          I32, // KIND
          this.deps.promRef(), // P
          this.deps.errRef(), // BUILTERR
          this.deps.bytesRef(), // ACC
          this.deps.strRef(), // TMPSTR
          this.deps.dynRef(), // DYNRESULT
          this.deps.errRef(), // ERR
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /* ── finished()/eos() (STAGE D, board #77) ───────────────────────────
   *
   * FIN_HEAD's own header has the mechanism story (watcher LIST, fire-
   * and-clear from opClose, OP_FIN for late registration). This section:
   * the premature-close gate, the per-entry fire dispatch, the fire-all
   * pass, the CB/PROMISE registration entry points, and the cleanup
   * closure 1813's r3 claim needs. FIN_KIND_DYN is a real, reserved
   * value (stream.finishedDyn's own libCall name exists) but no entry
   * with that KIND is ever constructed this pass — no P1 claim needs a
   * dyn-boxed finished() callback, and dyn.callFn's zero/one-arg calling
   * convention for it is unbuilt; stream.finishedDyn's own emitter
   * dispatch refuses by name rather than passing FIN_KIND_DYN here. */

  /** `(state) -> errRef|null` — Node's own eos() premature-close gate
   * (rD-node §1a), computed ONCE at fire time: a real error always wins;
   * absent one, ANY side RS_SIDES says to watch (a construction-time
   * stamp — RS_SIDES's own header has the full upcast-vs-runtime-object
   * story; every watcher on one stream shares it, so this reads STATE,
   * never the entry) that hasn't reached its own natural completion
   * (RS_END_EMITTED / WS_FINISHED) synthesizes ERR_STREAM_PREMATURE_
   * CLOSE — settleConsumerCore's own literal (name "Error", code
   * "ERR_STREAM_PREMATURE_CLOSE", message "Premature close"),
   * finished()'s own contract. The two side-checks are OR'd rather than
   * sequenced like Node's own source: both produce the IDENTICAL error
   * shape, so which one "wins" on a duplex-shaped watcher with both
   * sides incomplete is not an observable difference (unlike Node's
   * source, which returns from the readable check first — a control-flow
   * detail with no output consequence here). */
  private finComputeErr(): number {
    return this.cached("finComputeErr", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef()], [this.deps.errRef()]), "%w.rs.finComputeErr");
      const c = new Code();
      const ST = 0, SIDES = 1;
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32Eqz();
      c.ifResult(this.deps.errRef());
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_SIDES);
      c.localSet(SIDES);
      // FIX ROUND (gate finding, v3/v4/v5): FIN_SIDE_UNSET means a
      // construction path missed its stamp — FIN_SIDE_UNSET's own header
      // explains why no plausible fallback value is safe here. Loud
      // named trap (a wasm-backend bug report, not a "not supported yet"
      // user-facing refusal — this is an internal-consistency failure,
      // never something a real Node program could trigger).
      c.localGet(SIDES);
      c.i32Const(FIN_SIDE_UNSET);
      c.i32Eq();
      c.ifResult(this.deps.errRef());
      this.deps.setUncaughtError(c, (cc) => {
        this.deps.buildErrorLit(
          cc,
          "%Error",
          "Error",
          (ccc) =>
            this.deps.lit(
              ccc,
              "wasm backend bug: finished()/eos() reached a stream with no RS_SIDES stamp (a construction path is missing one) — please report this",
            ),
          null,
        );
      });
      c.refNull(this.errType());
      c.else_();
      // readable-premature: RS_SIDES watches R or RW, and the readable
      // side hasn't reached 'end'.
      c.localGet(SIDES);
      c.i32Const(FIN_SIDE_W);
      c.i32Ne();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.i32And();
      // writable-premature: RS_SIDES watches W or RW, and the writable
      // side hasn't reached 'finish'.
      c.localGet(SIDES);
      c.i32Const(FIN_SIDE_R);
      c.i32Ne();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_FINISHED);
      c.i32Eqz();
      c.i32And();
      c.i32Or();
      c.ifResult(this.deps.errRef());
      this.deps.buildErrorLit(c, "%Error", "Error", (cc) => this.deps.lit(cc, "Premature close"), "ERR_STREAM_PREMATURE_CLOSE");
      c.else_();
      c.refNull(this.errType());
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** `(root, entry) -> void` — dispatch ONE watcher: FIN_KIND_CB calls
   * through FE_THUNK (destroyThunkSig's ABI, mirroring destroyErrCore's
   * own call_ref site verbatim — closure, this, error, thunk last);
   * FIN_KIND_PROMISE (sp.finished) settles directly, reusing
   * settleConsumerCore's own reject-with-error shape and a plain
   * f64/0-kind fulfill for the void success case (an awaited
   * `promise<VOID>` never reads the payload back — confirmed directly,
   * not assumed: a minimal repro of the exact 2564 shape, `const p =
   * f(); ...; await p;` where `f(): Promise<void>`, compiles AND runs
   * correctly against the current wasm backend today). Exhaustive over
   * {CB, PROMISE} this pass — see this section's own header on
   * FIN_KIND_DYN. */
  private fireOneFin(): number {
    return this.cached("fireOneFin", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.finEntryRef()], []), "%w.rs.fireOneFin");
      const c = new Code();
      const ROOT = 0, ENTRY = 1, ST = 2, ERR = 3, P = 4;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.call(this.finComputeErr());
      c.localSet(ERR);
      c.localGet(ENTRY);
      c.structGet(this.finEntryT(), FE_KIND);
      c.i32Const(FIN_KIND_CB);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ENTRY);
      c.structGet(this.finEntryT(), FE_CLOS);
      c.localGet(ROOT);
      c.localGet(ERR);
      c.localGet(ENTRY);
      c.structGet(this.finEntryT(), FE_THUNK);
      c.callRef(this.destroyThunkSig());
      c.else_();
      // FIN_KIND_PROMISE, exhaustive this pass (see header — DYN is
      // never constructed).
      c.localGet(ENTRY);
      c.structGet(this.finEntryT(), FE_CLOS);
      c.refCast(this.promType());
      c.localSet(P);
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(P);
      c.i32Const(this.deps.excTag.obj);
      c.f64Const(0);
      c.localGet(ERR);
      this.deps.errPreOf(c, (cc) => cc.localGet(ERR));
      c.i32Const(2);
      c.call(this.deps.promSettle());
      c.else_();
      // sp.finished resolves with undefined — no value; the settled
      // kind/payload here is never read back (this section's own header
      // note above).
      c.localGet(P);
      c.i32Const(this.deps.excTag.f64);
      c.f64Const(0);
      c.refNull(this.errType());
      c.i32Const(-1);
      c.i32Const(1);
      c.call(this.deps.promSettle());
      c.end();
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.errRef(), this.deps.promRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — fire and clear the WHOLE watcher list: detach
   * FIN_HEAD FIRST (nulled before any watcher runs), THEN walk the
   * detached list firing each entry — the native lane's own documented
   * reentrancy guard (scr_stream_notify_finished: a watcher whose own
   * invocation re-registers another finished() call, or runs its own
   * cleanup, cannot corrupt this walk since it is no longer reachable
   * from the struct's own field by the time any watcher runs). Called
   * from `opClose` (the willEmitClose:true default path, right after
   * 'close' — probe13) and from `opFin` (a late registration on an
   * already-closed stream — probe01/probe12, always async).
   *
   * FIX ROUND (gate finding, v3): FIRES IN REGISTRATION ORDER, not list
   * order. `finRegisterCbCore`/`finRegisterPromiseCore` PREPEND (O(1)
   * insert), which puts the list in LIFO order relative to registration
   * — a plain head-to-tail walk would fire LAST-registered-first. A
   * live-Node re-measurement (three `finished()` calls on one stream,
   * registered A/B/C) falsifies the earlier "no ordering guarantee"
   * claim this file used to carry: Node fires strictly in REGISTRATION
   * order (A, B, C), deterministically. Fixed by reversing the detached
   * list in place before firing (cheaper than a tail pointer paid on
   * every registration, since this reversal runs once per fire, not
   * once per registration — and P1's own two claims never register more
   * than one watcher per stream, so this pass never measured it; P2's
   * pipeline middle stages register two independently and WOULD have
   * silently reordered output without this fix). */
  private fireFinListCore(): number {
    return this.cached("fireFinListCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.fireFinList");
      const c = new Code();
      const ROOT = 0, ST = 1, CUR = 2, NEXT = 3, PREV = 4;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), FIN_HEAD);
      c.localSet(CUR);
      c.localGet(ST);
      c.refNull(this.finEntryT());
      c.structSet(this.stateT(), FIN_HEAD);
      // Reverse the detached list in place: CUR walks the OLD (prepend/
      // LIFO) order; PREV accumulates the reversed (registration/FIFO)
      // order by re-pointing each node's own FE_NEXT as it's visited.
      c.refNull(this.finEntryT());
      c.localSet(PREV);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.finEntryT(), FE_NEXT);
      c.localSet(NEXT);
      c.localGet(CUR);
      c.localGet(PREV);
      c.structSet(this.finEntryT(), FE_NEXT);
      c.localGet(CUR);
      c.localSet(PREV);
      c.localGet(NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      // Fire from PREV (the reversed head = registration order) to null.
      c.localGet(PREV);
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.finEntryT(), FE_NEXT);
      c.localSet(NEXT);
      // STAGE D P2: dispatch by KIND before firing — FIN_KIND_PIPELINE
      // entries go through firePipelineStageWatcher (role-based, real-
      // vs-placeholder-aware, distinct from fireOneFin's own RS_SIDES-
      // based CB/PROMISE computation) rather than fireOneFin itself,
      // keeping fireOneFin's own already-gate-approved P1 body untouched.
      c.localGet(CUR);
      c.structGet(this.finEntryT(), FE_KIND);
      c.i32Const(FIN_KIND_PIPELINE);
      c.i32Eq();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(CUR);
      c.call(this.firePipelineStageWatcher());
      c.else_();
      c.localGet(ROOT);
      c.localGet(CUR);
      c.call(this.fireOneFin());
      c.end();
      c.localGet(NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(
        idx,
        [this.stateRef(), this.finEntryRef(), this.finEntryRef(), this.finEntryRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> void` — OP_FIN's tick body (FIN_HEAD's own header). */
  private opFin(): number {
    return this.cached("opFin", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.rs.opFin");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.fireFinListCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ── pipeline() (STAGE D P2, board #77) ──────────────────────────────
   *
   * Byte transfer reuses pipeCore() pairwise, untouched — pipeCore is
   * PURE data/drain/end wiring with no eos()/premature-close logic of
   * its own (confirmed by reading its body before this section was
   * written). Everything below is NEW: the destroy-cascade + finishCount
   * bookkeeping Node's own pipeline.js layers ON TOP of pipe()+eos(),
   * via a `destroyer(stream, reading, writing)`-style watcher — ONE per
   * STAGE (not one per adjacent pipe() pair) — that this file builds as
   * a NEW FIN_KIND_PIPELINE entry on each stage's OWN existing FIN_HEAD,
   * reusing P1's list/detach/fire/OP_FIN machinery verbatim. */

  /** `(ctx, err, isPlaceholder: i32) -> void` — Node's own `finishImpl`,
   * ported (rD-node §1b, re-verified against probe09 for the
   * supersession rule): overwrites the captured error when NOTHING is
   * captured yet, OR when whatever IS captured is itself a placeholder
   * (premature-close synthesized by a stage's own destroyer watcher, NOT
   * a real 'error' event) — regardless of whether the NEW error is
   * itself real or a placeholder; a captured REAL error is never
   * overwritten by anything. Then, UNCONDITIONALLY (every call, not just
   * the one that just overwrote), destroys every stage with whatever
   * ctx.ERROR now holds — this mirrors Node's own "drain the [already-
   * emptied-or-not] destroys queue on every call where an error is
   * captured" behavior exactly, and relies entirely on destroyErrCore's
   * OWN existing RS_DESTROYED idempotency guard to make a repeat or
   * self-destroy call a free no-op — the SAME guard that already makes a
   * naturally-finished stage's own subsequent destroy() call harmless.
   * This is what reproduces 1814's own asserted teardown order
   * (t-close,s-err,s-close,w-err,w-close) with ZERO ordering logic of
   * its own: t's own destroy() (from its own _transform callback error)
   * already has [OP_ERROR(t), OP_CLOSE(t)] queued on the SHARED tick
   * FIFO before this cascade even runs (this function is called
   * SYNCHRONOUSLY from t's own 'error' event handler, itself firing
   * from inside t's own OP_ERROR tick); the cascade's destroy(s) and
   * destroy(w) calls append FRESH [OP_ERROR, OP_CLOSE] pairs onto the
   * SAME queue, after t's already-pending OP_CLOSE — the observed order
   * is a race that falls out of the existing FIFO, not a rule, and must
   * not be restated as one. */
  private pipelineFinishImpl(): number {
    return this.cachedRecursive(
      "pipelineFinishImpl",
      () => this.mb.declareFunc(this.mb.funcType([this.pipelineCtxRef(), this.deps.errRef(), I32], []), "%w.rs.pipelineFinishImpl"),
      (idx) => {
        const c = new Code();
        const CTX = 0, ERR = 1, ISPLACEHOLDER = 2, I = 3, N = 4;
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_ERRORSET);
        c.i32Eqz();
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_ERROR_IS_PLACEHOLDER);
        c.i32Or();
        c.ifVoid();
        c.localGet(CTX);
        c.localGet(ERR);
        c.structSet(this.pipelineCtxT(), PCTX_ERROR);
        c.localGet(CTX);
        c.localGet(ISPLACEHOLDER);
        c.structSet(this.pipelineCtxT(), PCTX_ERROR_IS_PLACEHOLDER);
        c.localGet(CTX);
        c.i32Const(1);
        c.structSet(this.pipelineCtxT(), PCTX_ERRORSET);
        c.end();
        // Unconditional cascade, construction order, using whatever
        // ctx.ERROR now holds (this call's own error, or an earlier
        // real one this call did NOT overwrite).
        c.i32Const(0);
        c.localSet(I);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_N);
        c.localSet(N);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_STAGES);
        c.localGet(I);
        c.arrayGet(this.pipelineStagesArrT());
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_ERROR);
        c.call(this.destroyErrCore());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.mb.setBody(idx, [I32, I32], c.bytes());
      },
    );
  }

  /** `(root, entry) -> void` — a pipeline stage's OWN destroyer-style
   * watcher fire (FIN_KIND_PIPELINE, dispatched from fireFinListCore's
   * own walk, NOT fireOneFin — see fireFinListCore's own comment on
   * why). Computes real-vs-placeholder-vs-clean using the SAME two-check
   * shape `finComputeErr` already established for CB/PROMISE (real
   * RS_ERROR wins; else a role-based premature-close synthesis), but
   * role-based (FE_ROLE, this stage's POSITION in ITS pipeline) rather
   * than RS_SIDES-based (this stream's OWN construction-time kind) —
   * pipeline's role assignment has no call-site-static-type axis at all,
   * so there is nothing here analogous to RS_SIDES's own upcast
   * divergence risk. GATE MOD 1: a non-clean status routes through the
   * SAME `pipelineFinishImpl` the raw 'error' listener uses (captures
   * the error, runs the cascade) — a stage destroyed prematurely mid-
   * pipeline (dst.destroy(), every construct in-tier once this lands)
   * must FAIL the pipeline, not just silently count as closed; a clean
   * status only counts. Every fire (clean or not) increments
   * CLOSED_COUNT and, once it reaches N, schedules the final callback
   * (the extra hop, probe12). */
  private firePipelineStageWatcher(): number {
    return this.cachedRecursive(
      "firePipelineStageWatcher",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.finEntryRef()], []), "%w.rs.firePipelineStageWatcher"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ENTRY = 1, ST = 2, CTX = 3, ROLE = 4;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ENTRY);
        c.structGet(this.finEntryT(), FE_CLOS);
        c.refCast(this.pipelineCtxT());
        c.localSet(CTX);
        c.localGet(ENTRY);
        c.structGet(this.finEntryT(), FE_ROLE);
        c.localSet(ROLE);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_ERROR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        // Real error: this stage's OWN RS_ERROR is set.
        c.localGet(CTX);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_ERROR);
        c.i32Const(0); // isPlaceholder = false
        c.call(this.pipelineFinishImpl());
        c.else_();
        // Role-based premature-close synthesis — finComputeErr's own
        // two conditions, ported for FE_ROLE instead of RS_SIDES.
        c.localGet(ROLE);
        c.i32Const(FIN_SIDE_W);
        c.i32Ne();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_END_EMITTED);
        c.i32Eqz();
        c.i32And();
        c.localGet(ROLE);
        c.i32Const(FIN_SIDE_R);
        c.i32Ne();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_FINISHED);
        c.i32Eqz();
        c.i32And();
        c.i32Or();
        c.ifVoid();
        c.localGet(CTX);
        this.deps.buildErrorLit(c, "%Error", "Error", (cc) => this.deps.lit(cc, "Premature close"), "ERR_STREAM_PREMATURE_CLOSE");
        c.i32Const(1); // isPlaceholder = true
        c.call(this.pipelineFinishImpl());
        c.end();
        c.end();
        c.localGet(CTX);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_CLOSED_COUNT);
        c.i32Const(1);
        c.i32Add();
        c.structSet(this.pipelineCtxT(), PCTX_CLOSED_COUNT);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_CLOSED_COUNT);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_N);
        c.i32Eq();
        c.ifVoid();
        c.localGet(CTX);
        c.call(this.schedulePipelineFinal());
        c.end();
        this.mb.setBody(idx, [this.stateRef(), this.pipelineCtxRef(), I32], c.bytes());
      },
    );
  }

  /** `(ctx) -> void` — the terminal dispatcher: fires ONCE, when
   * PCTX_CLOSED_COUNT reaches PCTX_N (scheduled by
   * schedulePipelineFinal/dispatchPipelineFinal's own extra-hop tick
   * queue, probe12's own extra hop). Dispatches on PCTX_FINAL_KIND
   * exactly like fireOneFin dispatches on FE_KIND, but `this` is fixed
   * to the LAST stage (STAGES[N-1] — lower-stream.ts's own `thisType =
   * last.type` contract) rather than ROOT: pipeline()'s callback/promise
   * resolves against the destination stream, not any one watcher's own
   * stream.
   *
   * FIN_KIND_CB: PCTX_FINAL_THUNK is a `finThunkFor(...)`-built adapter,
   * the SAME destroyThunkSig() ABI fireOneFin's own CB branch calls
   * through — finThunkFor is reused VERBATIM (lower-stream.ts's own
   * contract: pipeline's callback tuple is `[errorOrNull(L)]`, IDENTICAL
   * to finished()'s own shape, so no second thunk-building function was
   * needed).
   *
   * FIN_KIND_DYN: 1814's own `wrap(fn)` shape — the frontend cannot pin
   * the callback to a static func type, so PCTX_FINAL_CLOS holds a raw
   * dyn FUNC value instead of a closure struct, called through
   * `dyn.callFn()` with a 2-element args array. Live-measured (this
   * file's `fromError` dep doc, above): Node always calls the pipeline
   * callback with TWO arguments, `(err, val)`, and `val` is undefined in
   * every shape this tier's corpus reaches — so the second element is a
   * fixed `undefinedDynGlobal`, never threaded from anywhere else. A
   * pending exception the callee itself raises is NOT checked here — the
   * same "caller already checks" contract `jsonParse` documents: this
   * function only ever runs via `dispatchPipelineFinal`, itself always
   * reached through `enqueueRaw()`, so nexttick.ts's own drain loop
   * checks `excKind()` right after this returns (fireOneFin's own CB
   * branch leans on the identical contract for its own `callRef`).
   *
   * FIN_KIND_PROMISE (sp.pipeline): settles PCTX_FINAL_CLOS (a promRef)
   * directly — fireOneFin's own PROMISE branch, ported verbatim (a void
   * success resolves with the same fixed f64/0-kind payload, never read
   * back). */
  private firePipelineFinal(): number {
    return this.cachedRecursive(
      "firePipelineFinal",
      () => this.mb.declareFunc(this.mb.funcType([this.pipelineCtxRef()], []), "%w.rs.firePipelineFinal"),
      (idx) => {
        const c = new Code();
        const CTX = 0, ERR = 1, LAST = 2, P = 3, FN = 4, ARGS = 5;
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_ERROR);
        c.localSet(ERR);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_STAGES);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_N);
        c.i32Const(1);
        c.i32Sub();
        c.arrayGet(this.pipelineStagesArrT());
        c.localSet(LAST);

        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_KIND);
        c.i32Const(FIN_KIND_CB);
        c.i32Eq();
        c.ifVoid();
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_CLOS);
        c.localGet(LAST);
        c.localGet(ERR);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_THUNK);
        c.callRef(this.destroyThunkSig());
        c.else_();
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_KIND);
        c.i32Const(FIN_KIND_DYN);
        c.i32Eq();
        c.ifVoid();
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_CLOS);
        c.refCast(this.deps.dynT());
        c.localSet(FN);
        c.i32Const(2); // the dyn-vec's own `len` field, ahead of `buf` (emitDataFrom's own precedent)
        c.localGet(ERR);
        c.refIsNull();
        c.ifResult(this.deps.dynRef());
        c.globalGet(this.deps.undefinedDynGlobal());
        c.else_();
        c.localGet(ERR);
        c.call(this.deps.fromError());
        c.end();
        c.globalGet(this.deps.undefinedDynGlobal());
        c.arrayNewFixed(this.deps.dynArrBufType(), 2);
        c.structNew(this.deps.dynArrStructType());
        c.localSet(ARGS);
        c.localGet(FN);
        c.localGet(ARGS);
        this.deps.lit(c, "value");
        c.call(this.deps.callFn());
        c.drop();
        c.else_();
        // FIN_KIND_PROMISE (sp.pipeline) — fireOneFin's own promise-
        // settle shape, ported verbatim.
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_FINAL_CLOS);
        c.refCast(this.promType());
        c.localSet(P);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(P);
        c.i32Const(this.deps.excTag.obj);
        c.f64Const(0);
        c.localGet(ERR);
        this.deps.errPreOf(c, (cc) => cc.localGet(ERR));
        c.i32Const(2);
        c.call(this.deps.promSettle());
        c.else_();
        c.localGet(P);
        c.i32Const(this.deps.excTag.f64);
        c.f64Const(0);
        c.refNull(this.errType());
        c.i32Const(-1);
        c.i32Const(1);
        c.call(this.deps.promSettle());
        c.end();
        c.end();
        c.end();
        this.mb.setBody(
          idx,
          [this.deps.errRef(), this.deps.rootRef(), this.deps.promRef(), this.deps.dynRef(), this.deps.dynArrRef()],
          c.bytes(),
        );
      },
    );
  }

  /** pipeline()'s own internal 'error' listener thunk, registered on
   * EVERY stage — Node's own pipeline() registers a real 'error'
   * listener on each stream as a side effect of being called (`opError`'s
   * own STAGE D note: this is why pipeline "owns" the error and no
   * unhandled-'error' crash occurs — 1814's own header comment). Calls
   * `pipelineFinishImpl` SYNCHRONOUSLY — from inside the erroring
   * stage's own OP_ERROR tick, which is what reproduces Node's own
   * teardown order as an emergent FIFO property (`pipelineFinishImpl`'s
   * own header explains why, in detail, and it must not be restated as
   * a rule here either).
   *
   * LAYER 6 (P2-1 fix round, bounded diagnosis, err-bucket hypothesis
   * CONFIRMED by reading events.ts): this thunk MUST be declared against
   * `errThunkSig()` (`(clos: eq, err: errRef) -> void`, a real error
   * reference directly — no dyn box, no `toError()` unboxing needed at
   * all) and registered via `errEntryAppend`, NOT the general family
   * (`thunkSig()`/`entryAppend`) this used before. `errDispatch()`/
   * `hasErrorListeners()` read ONLY `reg.errBucket` (confirmed reading
   * both bodies) — the general family's own `entryAppend(root, "error",
   * ...)` creates a bucket named "error" inside `reg.head` instead, a
   * DIFFERENT storage, structurally invisible to both. That was the
   * actual root cause of probe08's residual (measured via direct
   * instrumentation, prior pass of this fix round): this thunk was
   * confirmed REGISTERED on every stage but never actually INVOKED when
   * `errDispatch()` ran for the erroring stage, so the cascade this
   * thunk is supposed to trigger only ever happened LATER in practice,
   * via `firePipelineStageWatcher`'s own FIN_HEAD-list dispatch from
   * `buildOpClose`'s `fireFinListCore()` call — after 'close' already
   * emitted, exactly probe08's observed w-close-before-t-_destroy
   * divergence. */
  private pipelineErrThunk(): number {
    return this.cached("pipelineErrThunk", () => {
      const idx = this.mb.declareFunc(this.deps.errThunkSig(), "%w.rs.pipelineErrThunk");
      const c = new Code();
      const CLOS = 0, ERR = 1, CTX = 2;
      c.localGet(CLOS);
      c.refCast(this.pipelineCtxT());
      c.localSet(CTX);
      c.localGet(CTX);
      c.localGet(ERR);
      c.i32Const(0); // isPlaceholder = false
      c.call(this.pipelineFinishImpl());
      this.mb.setBody(idx, [this.pipelineCtxRef()], c.bytes());
      return idx;
    });
  }

  /** `(root, ctx, role: i32) -> void` — registers ONE stage's own
   * FIN_KIND_PIPELINE watcher (`finRegisterCbCore`'s own already-closed
   * fast path + emitClose:false trap, ported: pipeline's watchers ride
   * the SAME FIN_HEAD list finished()/eos() use, so the SAME "this
   * mechanism can only ever fire from opClose" constraint applies — no
   * new failure class, the existing one) AND the raw 'error' listener
   * (`pipelineErrThunk`, above). LAYER 6: registration goes through
   * `errEntryAppend` — the err-bucket's OWN door — NOT the general
   * `entryAppend` this used before (`pipelineErrThunk`'s own header has
   * the full measured story: the general family's bucket, even one
   * literally named "error", is invisible to `errDispatch`). */
  private pipelineRegisterOneStage(): number {
    return this.cachedRecursive(
      "pipelineRegisterOneStage",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.pipelineCtxRef(), I32], []), "%w.rs.pipelineRegisterOneStage"),
      (idx) => {
        this.mb.declareFuncRef(this.pipelineErrThunk());
        const c = new Code();
        const ROOT = 0, CTX = 1, ROLE = 2, ST = 3, ENTRY = 4;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_EMIT_CLOSE);
        c.ifVoid();
        c.localGet(ST);
        c.structGet(this.stateT(), FIN_HEAD);
        c.i32Const(FIN_KIND_PIPELINE);
        c.localGet(CTX);
        c.refNull(this.destroyThunkSig()); // FE_THUNK — unused for FIN_KIND_PIPELINE
        c.localGet(ROLE);
        c.structNew(this.finEntryT());
        c.localSet(ENTRY);
        c.localGet(ST);
        c.localGet(ENTRY);
        c.structSet(this.stateT(), FIN_HEAD);
        c.localGet(ST);
        c.structGet(this.stateT(), RS_CLOSE_EMITTED);
        c.ifVoid();
        c.localGet(ROOT);
        c.i32Const(OP_FIN);
        c.call(this.scheduleTick());
        c.end();
        c.else_();
        this.deps.setUncaughtError(c, (cc) => {
          this.deps.buildErrorLit(
            cc,
            "%Error",
            "Error",
            (ccc) => this.deps.lit(ccc, "pipeline() over a stream constructed with emitClose:false is not supported yet"),
            null,
          );
        });
        c.end();
        // The raw 'error' listener — errEntryAppend's own (root, clos,
        // thunk, once, prepend) ABI: no `name` (the bucket IS "error" by
        // definition), no `orig` (an internal registration has no
        // wrapped-listener identity to track) — errEntryAppend's own
        // header in events.ts.
        c.localGet(ROOT);
        c.localGet(CTX);
        c.refFunc(this.pipelineErrThunk());
        c.i32Const(0); // once
        c.i32Const(0); // prepend
        c.call(this.deps.errEntryAppend());
        this.mb.setBody(idx, [this.stateRef(), this.finEntryRef()], c.bytes());
      },
    );
  }

  /** `(ctx) -> void` — pipeline()'s own top-level registration: pairwise
   * `pipeCore()` byte-transfer wiring (untouched machinery, `end: true`
   * always — Node's own pipeline.js default for every adjacent pair,
   * this section's own header) plus each stage's OWN destroyer-style
   * watcher and raw 'error' listener (`pipelineRegisterOneStage`).
   * Role-by-POSITION, live-measured (not assumed): the SOURCE (i=0) is
   * FIN_SIDE_R, the DESTINATION (i=N-1) is FIN_SIDE_W, and every MIDDLE
   * stage is FIN_SIDE_RW — confirmed directly against real Node (a
   * middle Transform stage, destroyed after its OWN read side had ended
   * but before its OWN write side had finished, DOES report
   * ERR_STREAM_PREMATURE_CLOSE; an R-only role would not have). N==1 is
   * unreachable: `stream.pipeline`/`stream.pipelineDyn`/`sp.pipeline`
   * all refuse below 2/3 arguments respectively at lowering (lower-
   * stream.ts), so `i===0 && i===N-1` never both hold here.
   *
   * Emitter.ts's pipeline dispatch case builds the fully-populated ctx
   * (PCTX_N/STAGES/FINAL_KIND/FINAL_CLOS/FINAL_THUNK) BEFORE calling
   * this — this function only wires, never allocates.
   *
   * S053 (registered, NOT built): Node's real `pipeline()` validates
   * every PIPE-TO stage BEFORE wiring anything — the error message is
   * exact and load-bearing ("Cannot pipe TO a closed or destroyed
   * stream"): every stage except the SOURCE is piped-to by its
   * predecessor, so a MIDDLE or DESTINATION stage already destroyed at
   * call time makes `pipeline()` throw SYNCHRONOUSLY (ERR_STREAM_
   * UNABLE_TO_PIPE), the callback never invoked — but a pre-destroyed
   * SOURCE is NOT a divergence at all (measured both sides: Node itself
   * settles that case asynchronously via premature-close, matching this
   * tier already). This function has no pre-flight check at any
   * position — every stage wires normally and settles later via the
   * ordinary premature-close route (S053's own header has the full
   * three-position measured story). Board item #81 (lead-side) is this
   * check, scoped correctly by S053's own mechanism note: NOT a blanket
   * walk over PCTX_STAGES (that would wrongly make source throw too,
   * creating a new divergence at the one position that's currently
   * correct) — the check belongs on the DESTINATION side of each
   * `pipeCore()` pairwise call, i.e. stages `1..N-1`, never stage `0`. */
  pipelineRegisterCore(): number {
    return this.cachedRecursive(
      "pipelineRegisterCore",
      () => this.mb.declareFunc(this.mb.funcType([this.pipelineCtxRef()], []), "%w.rs.pipelineRegister"),
      (idx) => {
        this.mb.declareFuncRef(this.pipelineErrThunk());
        const c = new Code();
        const CTX = 0, N = 1, STAGES = 2, I = 3, ROLE = 4;
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_N);
        c.localSet(N);
        c.localGet(CTX);
        c.structGet(this.pipelineCtxT(), PCTX_STAGES);
        c.localSet(STAGES);

        // Pairwise: pipeCore(STAGES[i], STAGES[i+1], end=true), i in [0, N-2].
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32Const(1);
        c.i32Sub();
        c.i32GeS();
        c.brIf(1);
        c.localGet(STAGES);
        c.localGet(I);
        c.arrayGet(this.pipelineStagesArrT());
        c.localGet(STAGES);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.arrayGet(this.pipelineStagesArrT());
        c.i32Const(1); // end = true, always (pipeline.js's own default)
        c.call(this.pipeCore());
        c.drop();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();

        // Per-stage: role by position, then FIN_KIND_PIPELINE watcher +
        // raw 'error' listener.
        c.i32Const(0);
        c.localSet(I);
        c.block();
        c.loop();
        c.localGet(I);
        c.localGet(N);
        c.i32GeS();
        c.brIf(1);
        c.localGet(I);
        c.i32Eqz();
        c.ifResult(I32);
        c.i32Const(FIN_SIDE_R);
        c.else_();
        c.localGet(I);
        c.localGet(N);
        c.i32Const(1);
        c.i32Sub();
        c.i32Eq();
        c.ifResult(I32);
        c.i32Const(FIN_SIDE_W);
        c.else_();
        c.i32Const(FIN_SIDE_RW);
        c.end();
        c.end();
        c.localSet(ROLE);
        c.localGet(STAGES);
        c.localGet(I);
        c.arrayGet(this.pipelineStagesArrT());
        c.localGet(CTX);
        c.localGet(ROLE);
        c.call(this.pipelineRegisterOneStage());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.br(0);
        c.end();
        c.end();
        this.mb.setBody(idx, [I32, this.pipelineStagesArrRef(), I32, I32], c.bytes());
      },
    );
  }

  /** finished()'s own return value (the callback form ONLY — Node's real
   * eos() cancel/cleanup function): a genuine `() => void` closure
   * (`closPairFor([],[])`'s shape, `this.deps.voidClos()`) capturing
   * {root, entry}, whose body walks FIN_HEAD and splices this exact
   * entry out BY IDENTITY (ref.eq) — idempotent by construction: calling
   * it after the entry already fired (fireFinListCore already detached
   * and cleared FIN_HEAD) or calling it twice both land on an empty/
   * already-spliced list, a correct no-op (Node's own cleanup() is
   * documented idempotent). ONE shared struct type + ONE shared thunk
   * function serve every registration (doneClosFor's own template,
   * emitter.ts:3259 — captures differ per INSTANCE via struct.new's
   * fields, not per function). */
  private finCleanupStructField: number | null = null;
  private finCleanupFnField: number | null = null;
  private finCleanupStruct(): { struct: number; fn: number } {
    if (this.finCleanupStructField !== null && this.finCleanupFnField !== null) {
      return { struct: this.finCleanupStructField, fn: this.finCleanupFnField };
    }
    const pair = this.deps.voidClos();
    const rootRef = this.deps.rootRef();
    const fields: FieldType[] = [
      { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false }, // code
      { storage: rootRef, mutable: false }, // CLEAN_ROOT
      { storage: this.finEntryRef(), mutable: false }, // CLEAN_ENTRY
    ];
    const struct = this.mb.subStructType("stream.finCleanup", fields, pair.clos);
    const idx = this.mb.declareFunc(pair.fn, "%w.rs.finCleanup");
    this.finCleanupStructField = struct;
    this.finCleanupFnField = idx;
    const c = new Code();
    const SELF = 0, SELFT = 1, ROOT = 2, ENTRY = 3, ST = 4, CUR = 5, PREV = 6;
    c.localGet(SELF);
    c.refCast(struct);
    c.localSet(SELFT);
    c.localGet(SELFT);
    c.structGet(struct, 1); // CLEAN_ROOT
    c.localSet(ROOT);
    c.localGet(SELFT);
    c.structGet(struct, 2); // CLEAN_ENTRY
    c.localSet(ENTRY);
    c.localGet(ROOT);
    c.call(this.stateEnsure());
    c.localSet(ST);
    c.localGet(ST);
    c.structGet(this.stateT(), FIN_HEAD);
    c.localSet(CUR);
    c.refNull(this.finEntryT());
    c.localSet(PREV);
    // Walk once; on a match, splice it out and set CUR null (the loop's
    // own top-of-body null check then exits on the NEXT pass) — avoids
    // an extra branch depth out through the enclosing `if`.
    c.block();
    c.loop();
    c.localGet(CUR);
    c.refIsNull();
    c.brIf(1);
    c.localGet(CUR);
    c.localGet(ENTRY);
    c.refEq();
    c.ifVoid();
    c.localGet(PREV);
    c.refIsNull();
    c.ifVoid();
    c.localGet(ST);
    c.localGet(CUR);
    c.structGet(this.finEntryT(), FE_NEXT);
    c.structSet(this.stateT(), FIN_HEAD);
    c.else_();
    c.localGet(PREV);
    c.localGet(CUR);
    c.structGet(this.finEntryT(), FE_NEXT);
    c.structSet(this.finEntryT(), FE_NEXT);
    c.end();
    c.refNull(this.finEntryT());
    c.localSet(CUR);
    c.else_();
    c.localGet(CUR);
    c.localSet(PREV);
    c.localGet(CUR);
    c.structGet(this.finEntryT(), FE_NEXT);
    c.localSet(CUR);
    c.end();
    c.br(0);
    c.end();
    c.end();
    this.mb.setBody(
      idx,
      [{ kind: "ref", nullable: true, typeIndex: struct }, rootRef, this.finEntryRef(), this.stateRef(), this.finEntryRef(), this.finEntryRef()],
      c.bytes(),
    );
    return { struct, fn: idx };
  }

  /** `(root, kind: i32, clos: eq nullable, thunk) -> () => void` —
   * `stream.finished`'s own registration (KIND is always FIN_KIND_CB
   * this pass, see this section's own header — kept as a real parameter,
   * not hardcoded, so a future stream.finishedDyn build reuses this
   * verbatim). Prepends the new entry (O(1) — `fireFinListCore`'s own
   * reversal-before-fire is what actually delivers Node's REGISTRATION-
   * order firing guarantee, re-measured directly: three finished() calls
   * on one stream fire strictly A, B, C, never reordered — the "no
   * ordering guarantee" claim this comment used to carry was falsified
   * by that measurement and has been corrected here). Already-
   * closed fast path: RS_CLOSE_EMITTED true at registration time
   * schedules OP_FIN instead of waiting for a 'close' that already ran —
   * Node's eos() ALWAYS schedules, even for an already-terminal stream
   * (probe01/probe12), never fires synchronously. Returns the cleanup
   * closure (1813's own r3 claim: `finished()`'s real return value,
   * called BEFORE the stream finishes, to prove the watcher never
   * fires). GATE FINDING: emitClose:false traps loudly by name (S050's
   * own `setUncaughtError`+`buildErrorLit` template) rather than
   * silently registering a watcher that could NEVER fire — this tier's
   * only path to firing a finished()/eos() watcher is `opClose`, and
   * `OP_CLOSE` itself is only ever scheduled when RS_EMIT_CLOSE is true
   * (destroyErrDefaultCore's own pre-existing gate); without this trap
   * the watcher would silently hang forever instead of loudly refusing —
   * the compiled-clean-zero-output class this tier's whole loudness
   * contract exists to prevent. No P1 claim exercises the "fire directly
   * on end/finish" mechanism willEmitClose:false actually needs (probe13
   * has the measured shape), so this traps rather than builds an
   * unpinned branch. */
  finRegisterCbCore(): number {
    return this.cached("finRegisterCbCore", () => {
      const root = this.deps.rootRef();
      const thunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.destroyThunkSig() };
      const retRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([root, I32, EQ_REF, thunkRef], [retRef]), "%w.rs.finRegisterCb");
      const c = new Code();
      const ROOT = 0, KIND = 1, CLOS = 2, THUNK = 3, ST = 4, ENTRY = 5;
      const cleanup = this.finCleanupStruct();
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_EMIT_CLOSE);
      c.ifResult(retRef);
      c.localGet(ST);
      c.structGet(this.stateT(), FIN_HEAD);
      c.localGet(KIND);
      c.localGet(CLOS);
      c.localGet(THUNK);
      c.i32Const(0); // FE_ROLE — unused for FIN_KIND_CB
      c.structNew(this.finEntryT());
      c.localSet(ENTRY);
      c.localGet(ST);
      c.localGet(ENTRY);
      c.structSet(this.stateT(), FIN_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CLOSE_EMITTED);
      c.ifVoid();
      c.localGet(ROOT);
      c.i32Const(OP_FIN);
      c.call(this.scheduleTick());
      c.end();
      this.mb.declareFuncRef(cleanup.fn);
      c.refFunc(cleanup.fn);
      c.localGet(ROOT);
      c.localGet(ENTRY);
      c.structNew(cleanup.struct);
      c.else_();
      this.deps.setUncaughtError(c, (cc) => {
        this.deps.buildErrorLit(
          cc,
          "%Error",
          "Error",
          (ccc) => this.deps.lit(ccc, "finished()/eos() on a stream constructed with emitClose:false is not supported yet"),
          null,
        );
      });
      c.refNull(this.deps.voidClos().clos);
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.finEntryRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> promise<void>` — `sp.finished`'s own registration:
   * always FIN_KIND_PROMISE, no user closure at all. Mirrors
   * `finRegisterCbCore`'s own already-closed fast path, prepend-list
   * shape, and emitClose:false trap; returns the minted promise directly
   * (no cleanup value — `stream/promises` exposes no unhook, Node's own
   * contract). */
  finRegisterPromiseCore(): number {
    return this.cached("finRegisterPromiseCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.deps.promRef()]), "%w.rs.finRegisterPromise");
      const c = new Code();
      const ROOT = 0, ST = 1, ENTRY = 2, P = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_EMIT_CLOSE);
      c.ifResult(this.deps.promRef());
      c.call(this.deps.promMint());
      c.localSet(P);
      c.localGet(ST);
      c.structGet(this.stateT(), FIN_HEAD);
      c.i32Const(FIN_KIND_PROMISE);
      c.localGet(P);
      c.refNull(this.destroyThunkSig());
      c.i32Const(0); // FE_ROLE — unused for FIN_KIND_PROMISE
      c.structNew(this.finEntryT());
      c.localSet(ENTRY);
      c.localGet(ST);
      c.localGet(ENTRY);
      c.structSet(this.stateT(), FIN_HEAD);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_CLOSE_EMITTED);
      c.ifVoid();
      c.localGet(ROOT);
      c.i32Const(OP_FIN);
      c.call(this.scheduleTick());
      c.end();
      c.localGet(P);
      c.else_();
      this.deps.setUncaughtError(c, (cc) => {
        this.deps.buildErrorLit(
          cc,
          "%Error",
          "Error",
          (ccc) => this.deps.lit(ccc, "finished()/eos() on a stream constructed with emitClose:false is not supported yet"),
          null,
        );
      });
      c.refNull(this.promType());
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.finEntryRef(), this.deps.promRef()], c.bytes());
      return idx;
    });
  }

  /* ── the scalar property surface ──────────────────────────────────── */

  /** `(root) -> f64` — STAGE C PASS 2, hex/utf8: `readableLength` UNDER
   * an active encoding counts STRING UNITS (Node's own `readableLength`
   * over a string-mode stream is `state.length` measured in JS string
   * `.length` terms, NOT bytes — 1744's own "wörld" pin: 11 units, not
   * the 12 utf8 bytes `ö` costs), not RS_LENGTH's raw byte count. hex
   * needs NO special counting (`hexEncodeStep`'s own header: 1 input
   * byte → 1 ASCII output byte, so RS_LENGTH already IS the string-unit
   * count for a hex-mode buffer) — only utf8 diverges, walked here
   * NON-DESTRUCTIVELY (a property read must not consume the buffer):
   * each chunk's own remaining slice (respecting CHUNK_OFF, same
   * addressing `takeFromChunks` uses) decodes independently and its
   * length sums in — sound because every STORED chunk is already a
   * complete, self-contained decoded-then-reencoded utf8 sequence
   * (pushCore's own decode-choke-point never stores a split tail, that
   * lives in RS_DEC_PENDING instead), so no cross-chunk boundary could
   * ever split a surrogate pair the walk needs to re-join. */
  lengthOf(): number {
    return this.cached("lengthOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.rs.length");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ENCODING);
      c.i32Const(1);
      c.i32Eq();
      c.ifResult(F64);
      c.localGet(ROOT);
      c.call(this.stringUnitsLengthOf());
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_LENGTH);
      c.end();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> f64` — `lengthOf`'s own utf8 arm, factored out: the
   * non-destructive per-chunk decode-and-sum walk, `lengthOf`'s own
   * header has the full story. */
  private stringUnitsLengthOf(): number {
    return this.cached("stringUnitsLengthOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.rs.stringUnitsLength");
      const c = new Code();
      const ROOT = 0, ST = 1, CUR = 2, TOTAL = 3, SLICE = 4, STR = 5;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_HEAD);
      c.localSet(CUR);
      c.f64Const(0);
      c.localSet(TOTAL);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.localGet(CUR);
      c.structGet(this.chunkT(), CHUNK_OFF);
      c.f64ConvertI32S();
      c.localGet(CUR);
      c.structGet(this.chunkT(), CHUNK_BYTES);
      c.structGet(this.deps.bytesStructType(), BYTES_LEN);
      c.f64ConvertI32S();
      c.call(this.deps.bytesSlice());
      c.localSet(SLICE);
      c.localGet(SLICE);
      c.call(this.deps.toStrUtf8());
      c.localSet(STR);
      c.localGet(TOTAL);
      c.localGet(STR);
      c.arrayLen();
      c.f64ConvertI32U();
      c.f64Add();
      c.localSet(TOTAL);
      c.localGet(CUR);
      c.structGet(this.chunkT(), CHUNK_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      c.localGet(TOTAL);
      this.mb.setBody(idx, [this.stateRef(), this.chunkRef(), F64, this.deps.bytesRef(), this.deps.strRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> f64` — `readableHighWaterMark`. */
  hwmOf(): number {
    return this.cached("hwmOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.rs.hwm");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_HWM);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — the raw tri-state (-1/0/1); the emitter.ts call
   * site maps this to the nullable-bool union `readableFlowing` answers
   * (-1 -> null). */
  flowingRaw(): number {
    return this.cached("flowingRaw", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.flowingRaw");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_FLOWING);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `_readableState.emittedReadable` (2572's pin). */
  emittedReadableOf(): number {
    return this.cached("emittedReadableOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.emittedReadable");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_EMITTED_READABLE);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `readableEnded` (Node's real getter: `state.
   * endEmitted`, exactly). */
  readableEndedOf(): number {
    return this.cached("readableEndedOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.readableEnded");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_END_EMITTED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `destroyed`. */
  destroyedOf(): number {
    return this.cached("destroyedOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.destroyedProp");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_DESTROYED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `readableObjectMode` (RS_OBJECT_MODE's own
   * header: always false except a Readable.from stream). */
  readableObjectModeOf(): number {
    return this.cached("readableObjectModeOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.readableObjectMode");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_OBJECT_MODE);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — `_readableState.ended` (RS_ENDED, distinct from
   * the top-level `readableEnded`/`_readableState.endEmitted`, which
   * both read RS_END_EMITTED — Node's real two-bit split, mirrored). */
  readableEndedInternalOf(): number {
    return this.cached("readableEndedInternalOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.endedInternal");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_ENDED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> errRef|null` — `stream.errored`. */
  erroredOf(): number {
    return this.cached("erroredOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [this.deps.errRef()]), "%w.rs.errored");
      const c = new Code();
      const ROOT = 0;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), RS_ERROR);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
   * STAGE C — the writable side (scr_stream.c's "── writable internals ──"
   * section ported). Shares this file's state struct/tick FIFO/scheduler
   * wholesale (this file's own header explains why: one struct, one
   * dispatcher, for every stream-rooted class regardless of which sides
   * it has). The queue (`$wReq`, WS_HEAD/WS_TAIL) represents EVERY
   * pending write UNIFORMLY, including the one currently in flight — it
   * is simply the head of the same list, never popped until ITS OWN
   * completion callback runs (Node's real `clearBuffer`/`doWrite`
   * shape). `writeThunkFor`/`finalThunkFor` (emitter.ts, mirroring
   * `readThunkFor`) build the done-closures user overrides receive and
   * call back into `afterWriteCore`/`finalDoneCore` below — this file
   * never constructs a per-signature closure itself (it doesn't know the
   * user's declared callback type; the emitter does). */

  /** `(state, wreq) -> void` — appends one write-request node to the
   * queue's tail (appendChunk's own append-only half, no `front` case:
   * writes never jump the queue). */
  private wsAppend(): number {
    return this.cached("wsAppend", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), this.wReqRef()], []), "%w.ws.append");
      const c = new Code();
      const ST = 0, N = 1;
      c.localGet(ST);
      c.structGet(this.stateT(), WS_TAIL);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), WS_HEAD);
      c.else_();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_TAIL);
      c.localGet(N);
      c.structSet(this.wReqT(), WREQ_NEXT);
      c.end();
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.stateT(), WS_TAIL);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root, chunk, cbClos: voidClos|null) -> bool` — `write()`'s core
   * (Node's real `writeOrBuffer`): always enqueues (the queue IS the
   * in-flight slot too), bumps `length`, kicks `doWriteCore` (a no-op if
   * already writing/corked), and returns `length < hwm` READ AFTER that
   * kick — if the kick completed SYNCHRONOUSLY (the user's `_write`
   * calls its callback inline, as every one of this stage's claims
   * does), `afterWriteCore` has already run and decremented `length`
   * back down by the time this reads it, matching Node's own observed
   * behavior (1688's own comment: "the below-hwm answer computed AFTER a
   * synchronous completion"). */
  writeCore(): number {
    return this.cachedRecursive(
      "writeCore",
      () =>
        this.mb.declareFunc(
          this.mb.funcType(
            [this.deps.rootRef(), this.deps.bytesRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
            [I32],
          ),
          "%w.ws.write",
        ),
      (idx) => {
        const c = new Code();
        const ROOT = 0, CHUNK = 1, CB = 2, ST = 3, N = 4, RETB = 5;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        // FIX ROUND (P2-1): reset the transient sync-error bit at every
        // write() entry — WS_SYNC_ERRORED's own header has the full
        // "never carried across calls" reset-discipline story.
        c.localGet(ST);
        c.i32Const(0);
        c.structSet(this.stateT(), WS_SYNC_ERRORED);
        // GATE FIX C2 (BLOCKING, lifted verbatim from Node's real
        // internal/streams/_write): "if ((state[kState] & kEnding) !== 0)
        // { err = new ERR_STREAM_WRITE_AFTER_END(); } ... if (err) {
        // process.nextTick(cb, err); errorOrDestroy(stream, err, true);
        // return err; }" — a write() on an already-ending stream never
        // reaches `writeOrBuffer` at all: no enqueue, no `_write` call,
        // just the error + (if present) the per-write callback + destroy
        // (errorOrDestroy calls `stream.destroy(err)` when autoDestroy is
        // set, this tier's own default). The callback's OWN nextTick is
        // enqueued BEFORE `destroy()`'s error/close ticks in the lifted
        // source, so it is scheduled first here too (WS_DISCARDED/
        // OP_FIRE_DISCARDED, the SAME zero-arg-callback machinery C4
        // uses — see that field's own header for why no error value
        // threads through). Measured (c-after-end.ts, this tier's own
        // oracle run): `write-after-end ret: false` prints BEFORE the
        // deferred `err event:` line — confirming the error is NOT
        // synchronous, matching the lifted source's own tick-based path.
        c.localGet(ST);
        c.structGet(this.stateT(), WS_ENDING);
        c.ifResult(I32);
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CHUNK);
        c.localGet(CB);
        c.refNull(this.wReqT());
        c.structNew(this.wReqT());
        c.localSet(N);
        c.localGet(ST);
        c.localGet(N);
        c.call(this.wsDiscardAppend());
        c.localGet(ROOT);
        c.i32Const(OP_FIRE_DISCARDED);
        c.call(this.scheduleTick());
        c.end();
        c.localGet(ROOT);
        this.deps.buildErrorLit(
          c,
          "%Error",
          "Error",
          (cc) => this.deps.lit(cc, "write after end"),
          "ERR_STREAM_WRITE_AFTER_END",
        );
        c.call(this.destroyErrCore());
        c.i32Const(0);
        c.else_();
        // GATE FIX F1/F2 (bug c, BLOCKING, lifted verbatim from Node's
        // real internal/streams/_write's OWN sibling branch to the
        // WS_ENDING/WRITE_AFTER_END check just above: "else if
        // ((state[kState] & kDestroyed) !== 0) { err = new
        // ERR_STREAM_DESTROYED('write') }"): a write() call landing
        // AFTER the stream is already destroyed must NOT enqueue or
        // dispatch to `_write` at all — this tier used to fall through
        // to the normal append+dispatch path below and call `_write`
        // anyway, which Node never does (bug c). WHERE the callback
        // lands relative to 'error'/'close' is NOT uniform, though —
        // measured across three probes (c-err-queue3.ts vs
        // f-write-after-destroy.ts vs f-mech-explicit-vs-autoDestroy.ts,
        // the last pair identical except for the trigger): a stream
        // destroyed by an in-flight write's OWN error fires a later
        // same-shape write's callback SYNCHRONOUSLY, before 'error'/
        // 'close' (c-err-queue3.ts: "cb two" before "err event"); a
        // stream destroyed by an EXPLICIT `.destroy()` call — with or
        // without an error — defers it PAST 'close' instead
        // (f-write-after-destroy.ts, f-mech-explicit-vs-autoDestroy.ts).
        // WS_DESTROY_SYNC (its own header, set only by afterWriteCore's
        // F1 branch) is the measured signal, not RS_DESTROYED alone.
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.ifResult(I32);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_DESTROY_SYNC);
        c.ifResult(I32);
        // F1's shape: fire now — whatever destroyed the stream already
        // scheduled OP_ERROR/OP_CLOSE (or will, on its own eventual
        // completion), and this fires before those ticks run.
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CB); // arg0: the closure itself (call_ref wants args, THEN the funcref)
        c.localGet(CB);
        c.structGet(this.deps.voidClos().clos, 0);
        c.callRef(this.deps.voidClos().fn);
        c.end();
        c.i32Const(0);
        c.else_();
        // F2's shape: defer past the already-scheduled OP_CLOSE (and
        // OP_ERROR, if any) — append to the SAME discard queue C4/C2
        // use and schedule its fire, landing AFTER them in FIFO order
        // exactly because they were scheduled first, at destroy() time,
        // strictly before this write() call could ever run.
        c.localGet(CHUNK);
        c.localGet(CB);
        c.refNull(this.wReqT());
        c.structNew(this.wReqT());
        c.localSet(N);
        c.localGet(ST);
        c.localGet(N);
        c.call(this.wsDiscardAppend());
        c.localGet(ROOT);
        c.i32Const(OP_FIRE_DISCARDED);
        c.call(this.scheduleTick());
        c.i32Const(0);
        c.end();
        c.else_();
        c.localGet(CHUNK);
        c.localGet(CB);
        c.refNull(this.wReqT());
        c.structNew(this.wReqT());
        c.localSet(N);
        c.localGet(ST);
        c.localGet(N);
        c.call(this.wsAppend());
        c.localGet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_LENGTH);
        c.localGet(CHUNK);
        c.structGet(this.deps.bytesStructType(), BYTES_LEN);
        c.f64ConvertI32S();
        c.f64Add();
        c.structSet(this.stateT(), WS_LENGTH);
        c.localGet(ROOT);
        c.call(this.doWriteCore());
        // FIX ROUND (P2-1): the return formula gains ONE more term —
        // WS_SYNC_ERRORED, set by writeDoneLandingCore (possibly just
        // now, synchronously, inside the doWriteCore() call above) the
        // instant this write's own callback reported an error, mirroring
        // Node's real state.errored role in write()'s own return value
        // (WS_SYNC_ERRORED's own header has the full measured story —
        // this is the ONLY reader). Every OTHER term is exactly as
        // before (GATE FIX C3's own hwm-comparison, unchanged).
        c.localGet(ST);
        c.structGet(this.stateT(), WS_LENGTH);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HWM);
        c.f64Lt();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_SYNC_ERRORED);
        c.i32Eqz();
        c.i32And();
        c.localSet(RETB);
        // GATE FIX C3 (the needDrain BIT half — lifted from Node's real
        // internal/streams/writable.js, `writeOrBuffer`: "if (!ret)
        // state[kState] |= kNeedDrain"): a false return marks the bit;
        // `afterWriteCore`'s drain-emission gate below reads it back
        // (the SAME lifted source's `afterWrite`, the OTHER half of the
        // conjunction). Every claim's own return-value computation stays
        // exactly as before (this file's own hwm-comparison, unchanged) —
        // only the bit-tracking is new.
        c.localGet(RETB);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_NEED_DRAIN);
        c.end();
        c.localGet(RETB);
        c.end(); // closes the RS_DESTROYED ifResult(I32)/else_ (GATE FIX F1/F2) — WS_DESTROY_SYNC's own inner ifResult(I32) already closed above, before this branch's else_
        c.end(); // closes the WS_ENDING ifResult(I32)/else_ opened at the top
        this.mb.setBody(idx, [this.stateRef(), this.wReqRef(), I32], c.bytes());
      },
    );
  }

  /** `(root) -> void` — dispatches the head-of-queue request to `_write`
   * if nothing is already in flight and the stream isn't corked; a no-op
   * otherwise (Node's real `clearBuffer`/`doWrite` idempotency — every
   * call site here calls this unconditionally and lets the guard decide,
   * rather than duplicating the condition at each call site). */
  doWriteCore(): number {
    return this.cachedRecursive(
      "doWriteCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.ws.doWrite"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ST = 1, HEAD = 2;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_WRITING);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_CORKED);
        c.f64Const(0);
        c.f64Gt();
        c.i32Or();
        c.ifVoid();
        c.return_();
        c.end();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.localTee(HEAD);
        c.refIsNull();
        c.ifVoid();
        c.return_();
        c.end();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_WRITING);
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_SYNC);
        // call_ref wants [args..., funcref] — the closure ITSELF (arg0),
        // `this`, chunk, encoding, wreq, THEN the funcref last.
        c.localGet(ST);
        c.structGet(this.stateT(), WS_WRITE_CLOS);
        c.localGet(ROOT);
        c.localGet(HEAD);
        c.structGet(this.wReqT(), WREQ_BYTES);
        this.deps.lit(c, "buffer");
        c.localGet(HEAD);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_WRITE_THUNK);
        c.callRef(this.writeThunkSig());
        // GATE FIX (pending-check audit, write-side — d13-sync-throw-
        // write.cjs): Node's real `doWrite` (internal/streams/writable.js)
        // wraps NEITHER `_write` NOR `_writev` in a try/catch — a
        // synchronous throw from a dyn-adapted override propagates
        // immediately, uncaught, crashing AT this call, before Node ever
        // reaches a later script statement (measured: real Node never
        // prints past `w.write('x')` when `_write` throws synchronously).
        // Prior to this fix, this function had no analogous check at all
        // — the thunk's throw left the exception cell set but execution
        // simply continued (WS_SYNC's reset below, then back out through
        // writeCore to the user's own next script statement), so the
        // eventual report landed at some LATER, unrelated checkpoint —
        // genuinely miscompile-adjacent (the #49 blind spot): a program
        // prints output BETWEEN the throw and the report that Node itself
        // never produces at all, invisible to a byte-for-byte harness
        // that only compares output once a divergence is already known.
        // Report-and-trap HERE, immediately, via the same bare-uncaught
        // path (S007) every other unwrapped synchronous throw already
        // uses — never falls through to the WS_SYNC reset below, exactly
        // matching Node's own "nothing after this point ever runs".
        // Contrast maybeFinishCore/buildDestroyErrCore just below in this
        // file: Node DOES wrap `_final`/`_destroy` internally, so THEIR
        // synchronous throws route through the ordinary async error path
        // instead — measured separately (d13b/d13c), not assumed
        // symmetric with this one.
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.call(this.deps.reportUncaught());
        c.end();
        c.localGet(ST);
        c.i32Const(0);
        c.structSet(this.stateT(), WS_SYNC);
        this.mb.setBody(idx, [this.stateRef(), this.wReqRef()], c.bytes());
      },
    );
  }

  /* ── LAYER 5 (afterWriteCore split, Joe-ruled fix): queue-continuation
   * vs completion-tail ── MEASURED (node v24.18.1, internal/streams/
   * writable.js via internalBinding("builtins").natives, `onwrite`):
   * Node's own per-write completion callback (`state.onwrite`, invoked
   * the instant `_write`'s cb fires — SYNCHRONOUSLY, unconditionally,
   * regardless of `state.sync`) does its bookkeeping (`state.length -=
   * state.writelen`, clear `kWriting`) UNCONDITIONALLY at the top, then
   * for the SUCCESS case calls `clearBuffer(stream, state)` — which
   * dispatches the NEXT buffered write, if any — ALSO unconditionally,
   * BEFORE any sync/defer decision exists in the source at all. Only
   * THEN does `onwrite` decide whether to defer `afterWrite`/
   * `afterWriteTick` (drain + the completed write's OWN callback +
   * `finishMaybe`) via `process.nextTick` — and even then, only when
   * `sync && needTick`, where (lines 655-656 of the extracted source):
   *   const needDrain = (state[kState] & kNeedDrain) !== 0 && state.length === 0;
   *   const needTick = needDrain || (state[kState] & kDestroyed !== 0) || cb !== nop;
   * (the middle clause is quoted VERBATIM — its own parenthesization
   * makes `!==` bind before `&`, so it literally tests `state[kState] &
   * true`, i.e. bit 0 of an unrelated flag word, not "is destroyed" —
   * almost certainly an unintentional quirk in Node's own source, not
   * behavior worth replicating bit-for-bit since it depends on Node's
   * OWN private bit layout I have no way to fault-for-fault reproduce.
   * Ported here by INTENT instead — RS_DESTROYED, the semantically
   * obvious reading — flagged as an approximated, not measured, clause;
   * none of this round's target shapes are destroyed at the point this
   * decision is made, so the term is inert for every banked/pinned
   * result, verified by the full battery this layer's own freeze
   * package cites). For the ERROR case, `onwrite` has NO needTick
   * refinement at all — `onwriteError` (the whole error path, including
   * eventual destroy) defers WHOLESALE whenever `sync`, exactly this
   * file's PRE-EXISTING (unchanged by this layer) WS_SYNC-only gate.
   *
   * `writeDoneLandingCore`, below, is what implements this split now:
   * it calls `afterWriteHeadCore` — the ALWAYS-IMMEDIATE half (pop head,
   * decrement length, clear WS_WRITING, and for a NON-fresh-error
   * completion, dispatch the next queued entry via `doWriteCore()`) —
   * unconditionally, BEFORE making any defer decision at all. Only the
   * REMAINING tail (this function, `afterWriteCore`, now taking the
   * ALREADY-POPPED entry's own callback closure as a parameter instead
   * of re-popping WS_HEAD itself) is what gets deferred, and only per
   * the needTick-ported condition above (success) or the unchanged
   * bare-WS_SYNC gate (error).
   *
   * THIS IS THE ROOT CAUSE of the gate's remaining probe08 divergence:
   * this file previously deferred `afterWriteCore` — bookkeeping AND
   * queue-continuation-dispatch INCLUDED — as one unit whenever WS_SYNC
   * was true. That kept `WS_WRITING` incorrectly true past the point
   * Node would already have cleared it, so a SUBSEQUENT synchronous
   * `write()` call on the SAME stream (arriving before the deferred tick
   * ran) found it still "writing" and wrongly QUEUED instead of
   * dispatching immediately — introducing an extra deferred hop that
   * lost a race it should have won. Nothing here is a new ordering RULE:
   * the corrected order is what falls out of clearing `WS_WRITING`
   * (and dispatching the next entry, if the completion wasn't a fresh
   * error) at the SAME point in the call graph Node does. */

  /** `(root, errRef|null) -> cbClosRef|null` — ALWAYS IMMEDIATE, never
   * gated on WS_SYNC (this section's own header has the measured
   * mechanism): pops WS_HEAD, updates WS_TAIL/WS_LENGTH/WS_WRITING, and
   * — unless this completion is a FRESH error (mirrors `afterWriteCore`'s
   * OWN F1 fresh-vs-collision test exactly: RS_DESTROYED is read here,
   * not written, so its value is identical to what F1's later check
   * would see) — dispatches the next queued entry via `doWriteCore()` if
   * one exists (Node's `clearBuffer`). Returns the popped entry's own
   * per-write callback closure so the caller can carry it into whichever
   * `afterWriteCore` call eventually fires (immediate or, via
   * `scheduleWriteCompletion`'s own WCT_CB_CLOS field, deferred) — a
   * captured VALUE, not a shared state field, exactly so a NESTED
   * completion this function's own `doWriteCore()` call may trigger
   * (the next entry ALSO completing synchronously) can never clobber
   * it before the outer completion's own tail reads it back. */
  private afterWriteHeadCore(): number {
    return this.cachedRecursive(
      "afterWriteHeadCore",
      () =>
        this.mb.declareFunc(
          this.mb.funcType(
            [this.deps.rootRef(), this.deps.errRef()],
            [{ kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
          ),
          "%w.ws.afterWriteHead",
        ),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ERR = 1, ST = 2, HEAD = 3, CBCLOS = 4, FRESH = 5;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.localTee(HEAD);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.deps.voidClos().clos);
        c.return_(); // defensive: no in-flight request (should not happen for any built path)
        c.end();
        c.localGet(ST);
        c.localGet(HEAD);
        c.structGet(this.wReqT(), WREQ_NEXT);
        c.structSet(this.stateT(), WS_HEAD);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.refIsNull();
        c.ifVoid();
        c.localGet(ST);
        c.refNull(this.wReqT());
        c.structSet(this.stateT(), WS_TAIL);
        c.end();
        c.localGet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_LENGTH);
        c.localGet(HEAD);
        c.structGet(this.wReqT(), WREQ_BYTES);
        c.structGet(this.deps.bytesStructType(), BYTES_LEN);
        c.f64ConvertI32S();
        c.f64Sub();
        c.structSet(this.stateT(), WS_LENGTH);
        c.localGet(ST);
        c.i32Const(0);
        c.structSet(this.stateT(), WS_WRITING);
        c.localGet(HEAD);
        c.structGet(this.wReqT(), WREQ_CB_CLOS);
        c.localSet(CBCLOS);
        // FRESH = (err != null) && (RS_DESTROYED == false) — the SAME
        // clause afterWriteCore's own F1 branch tests; a fresh error
        // discards the queue instead of draining it (Node's
        // onwriteError, not clearBuffer), so this skips the dispatch —
        // a collision (err != null but already destroyed) falls through
        // to dispatch exactly like a clean success, matching the
        // ORIGINAL undivided function's own fall-through shape (the
        // collision case never returned early there either).
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.i32Eqz();
        c.i32And();
        c.localSet(FRESH);
        c.localGet(FRESH);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.doWriteCore());
        c.end();
        c.end();
        c.localGet(CBCLOS);
        this.mb.setBody(
          idx,
          [this.stateRef(), this.wReqRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }, I32],
          c.bytes(),
        );
      },
    );
  }

  /** `(root, errRef|null, cbClosRef|null) -> void` — the done-closure's
   * landing TAIL (Node's real `afterWrite`/`onwriteError`): fires the
   * completed entry's own per-write callback (now a parameter — the
   * bookkeeping that used to pop it here already ran in
   * `afterWriteHeadCore`), routes a real error to `destroyErrCore`
   * (Node's `errorOrDestroy`), fires 'drain' once the queue empties past
   * a prior below-hwm write, and tries to finish. This section's own
   * header has the full measured mechanism story. */
  afterWriteCore(): number {
    return this.cachedRecursive(
      "afterWriteCore",
      () =>
        this.mb.declareFunc(
          this.mb.funcType(
            [this.deps.rootRef(), this.deps.errRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
            [],
          ),
          "%w.ws.afterWrite",
        ),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ERR = 1, CBCLOS = 2, ST = 3, ARGS = 4;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        // GATE FIX F1 (BLOCKING, C2's lost-continuation class — measured:
        // c-err-queue2.ts async, c-err-queue3.ts sync). Two shapes reach
        // here with ERR non-null, and they need OPPOSITE tail behavior:
        //
        //  - A FRESH error (RS_DESTROYED still false — nothing has
        //    destroyed this stream yet, so THIS is what does it): Node's
        //    measured order is every already-queued write's callback —
        //    this entry's own, then each queued one in order, NONE
        //    dispatched to `_write` — BEFORE 'error'/'close'. Fire them
        //    SYNCHRONOUSLY (this entry's own callback, then
        //    discardQueueCore + a DIRECT opFireDiscarded call, not a
        //    scheduled one), THEN call destroyErrCore — by the time its
        //    OP_ERROR/OP_CLOSE ticks actually run (the next checkpoint),
        //    everything above has already printed. The exact opposite
        //    of C4's own shape below, and correctly so: C4 is an
        //    EXTERNAL destroy() landing while a write is in flight
        //    (afterWriteCore never observes an error there — the real
        //    completion's own ERR is null), never this branch.
        //
        //  - A COLLISION (RS_DESTROYED already true — measured:
        //    c-err-destroy-collide.ts, an explicit destroy() already won
        //    the race before this stale error arrived): Node discards
        //    the stale error entirely (only the explicit destroy's own
        //    message ever reaches 'error') and this completion behaves
        //    EXACTLY like a normal one for ordering — close first, this
        //    entry's callback after, matching C4's shape exactly (the
        //    explicit destroy already did C4's own discardQueueCore +
        //    deferred-OP_FIRE_DISCARDED half). Do NOT return here — fall
        //    through to the shared tail below unchanged, and do NOT call
        //    destroyErrCore again (its own idempotency guard would
        //    no-op it, but the point is this branch never touches it).
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CBCLOS);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CBCLOS); // arg0 (call_ref wants args, THEN the funcref)
        c.localGet(CBCLOS);
        c.structGet(this.deps.voidClos().clos, 0);
        c.callRef(this.deps.voidClos().fn);
        c.end();
        // GATE FIX F2: record that THIS destroy is the "in-flight write's
        // own error" kind — writeCore's own RS_DESTROYED branch reads
        // this back to pick synchronous-fire (this shape) vs deferred
        // (an explicit `.destroy()` call, WS_DESTROY_SYNC's own header).
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_DESTROY_SYNC);
        c.localGet(ROOT);
        c.call(this.discardQueueCore());
        c.localGet(ROOT);
        c.call(this.opFireDiscarded());
        c.localGet(ROOT);
        c.localGet(ERR);
        c.call(this.destroyErrCore());
        c.return_();
        c.end();
        c.end();
        // Node's REAL order (measured against 1689: completing a queued
        // write DISPATCHES the next one, or fires 'drain', BEFORE the
        // just-completed entry's OWN per-write callback runs — "write:
        // bbbb" prints before "cb a" when a second write was queued
        // behind the first; "drain" prints before "cb b" when the queue
        // empties past a below-hwm write). LAYER 5: dispatching the next
        // entry now happens in `afterWriteHeadCore`, ALWAYS immediately,
        // before this tail (deferred or not) ever runs — 'drain' stays
        // here, in the tail, exactly matching Node's OWN split (`drain`
        // lives inside `afterWrite`, deferred alongside the completed
        // write's own callback, NOT inside `clearBuffer`).
        //
        // GATE FIX C3 (BLOCKING precondition, lifted verbatim from Node's
        // real internal/streams/writable.js's `afterWrite`, dumped via
        // internalBinding("builtins").natives): `const needDrain =
        // (state[kState] & (kEnding | kNeedDrain | kDestroyed)) ===
        // kNeedDrain && state.length === 0;` — a bitmask conjunction, NOT
        // length-alone: the needDrain BIT must be set (a prior write()
        // call answered false — writeCore's own new WS_NEED_DRAIN write,
        // this gate's other half) AND `ending`/`destroyed` must BOTH be
        // clear. `destroyed` is unreached by any path that reaches this
        // point in THIS file (destroyErrCore short-circuits before ever
        // calling back in here — see its own `return_()` above), so the
        // clause is carried for fidelity to the lifted source, not
        // because a claim or probe exercises it; `ending` is what 1693's/
        // 1743's/the reviewer's own two probes (c-order.ts,
        // c-backpressure.ts, both call end() before the queue drains)
        // measure — 1689 (byte-exact, unaffected) is the control that
        // proves a NOT-yet-ending stream still fires 'drain' correctly.
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.refIsNull();
        c.ifVoid();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_NEED_DRAIN);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_ENDING);
        c.i32Eqz();
        c.i32And();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.i32Eqz();
        c.i32And();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_LENGTH);
        c.f64Const(0);
        c.f64Eq();
        c.i32And();
        c.ifVoid();
        c.localGet(ST);
        c.i32Const(0);
        c.structSet(this.stateT(), WS_NEED_DRAIN);
        this.emitNoArgFrom(c, ROOT, "drain", ARGS);
        c.end();
        c.localGet(ROOT);
        c.call(this.maybeFinishCore());
        c.end();
        c.localGet(CBCLOS);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(CBCLOS); // arg0: the closure itself (call_ref wants args, THEN the funcref)
        c.localGet(CBCLOS);
        c.structGet(this.deps.voidClos().clos, 0);
        c.callRef(this.deps.voidClos().fn);
        c.end();
        // GATE FIX C4 v2: this completed entry may be the exact one
        // discardQueueCore left in flight when a destroy() call landed
        // mid-write (destroyErrDefaultCore's own half of this fix, above
        // — it deliberately skipped scheduling OP_FIRE_DISCARDED THEN so
        // as not to race ahead of this real completion). Its own
        // callback has just fired, immediately above — chain the
        // discarded queue's fire onto THIS tick, after it, exactly
        // matching Node's measured order (c-destroy-cbfate.ts: "cb one"
        // then "cb two"). A destroy() that never caught anything in
        // flight leaves WS_DISCARDED null here — nothing to do; the
        // OTHER half already fired it immediately in that case.
        c.localGet(ST);
        c.structGet(this.stateT(), WS_DISCARDED);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.i32Const(OP_FIRE_DISCARDED);
        c.call(this.scheduleTick());
        c.end();
        this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      },
    );
  }

  /** `(root, op: i32) -> void` — the public face of `scheduleTick` for
   * callers outside this file's own tick-op handlers (emitter.ts's
   * done-closure bodies need to reach `afterWriteCore`/`finalDoneCore`
   * directly, but 'drain'/'finish' themselves still always schedule). */
  private scheduleTickPublic(): number {
    return this.scheduleTick();
  }

  /** `(root) -> void` — Node's real `finishMaybe`: nothing to finish
   * unless `end()` was called, the queue is empty, nothing is in flight,
   * and it hasn't already finished; runs `_final` (if any) or proceeds
   * straight to the prefinished state. */
  maybeFinishCore(): number {
    return this.cachedRecursive(
      "maybeFinishCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.ws.maybeFinish"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ST = 1, ERR = 2;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_ENDING);
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_FINISHED);
        c.i32Or();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_HEAD);
        c.refIsNull();
        c.i32Eqz();
        c.i32Or();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_WRITING);
        c.i32Or();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.i32Or();
        c.ifVoid();
        c.return_();
        c.end();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_ENDED);
        c.ifVoid();
        c.return_(); // already ran the final step once (idempotency guard)
        c.end();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_ENDED);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_FINAL_CLOS);
        c.refIsNull();
        c.ifVoid();
        c.localGet(ROOT);
        c.refNull(this.errType());
        c.call(this.finalDoneCore());
        c.else_();
        // call_ref wants [args..., funcref] — the closure itself, `this`,
        // THEN the funcref last.
        c.localGet(ST);
        c.structGet(this.stateT(), WS_FINAL_CLOS);
        c.localGet(ROOT);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_FINAL_THUNK);
        c.callRef(this.finalThunkSig());
        // GATE FIX (pending-check audit, final-side — d13b-sync-throw-
        // final.cjs, measured BEFORE wiring, per the sibling rule: do not
        // assume write's shape). Node's real `callFinal` DOES wrap
        // `stream._final()` in a try/catch, whose catch arm calls the
        // exact same `onFinish(err)` its own completion-callback argument
        // reaches on a normal call — measured: the resulting 'error'
        // event fires ASYNCHRONOUSLY (well after a 'sync' marker
        // statement already ran), the same deferred shape the callback
        // path already produces via `finalDoneCore`'s own `destroyErrCore`
        // call. So a thunk that throws INSTEAD OF calling its own
        // completion callback needs the IDENTICAL landing, not an
        // immediate crash (contrast doWriteCore just above — genuinely
        // different, not symmetric): extract the pending Error-shaped
        // exception (`tryCatchAsError`, D2's own established idiom, reused
        // verbatim) and hand it to `finalDoneCore`, exactly as if the
        // callback itself had been invoked with it.
        this.deps.tryCatchAsError(c);
        c.localSet(ERR);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.localGet(ERR);
        c.call(this.finalDoneCore());
        c.end();
        c.end();
        this.mb.setBody(idx, [this.stateRef(), this.deps.errRef()], c.bytes());
      },
    );
  }

  /** `(root, errRef|null) -> void` — the `_final` done-closure's landing
   * site (or `maybeFinishCore`'s own direct call when no `_final` is
   * bound): a real error routes to `destroyErrCore` (Node's own
   * `errorOrDestroy`); otherwise flips `prefinished` and schedules
   * 'finish'. */
  finalDoneCore(): number {
    return this.cachedRecursive(
      "finalDoneCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.errRef()], []), "%w.ws.finalDone"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ERR = 1, ST = 2, ARGS = 3;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.localGet(ERR);
        c.call(this.destroyErrCore());
        c.return_();
        c.end();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_PREFINISHED);
        // 'prefinish' fires SYNCHRONOUSLY here (Node's real `finishMaybe`
        // — unlike 'finish', which always defers a tick): 1688/1741's own
        // pin, "prefinish" printing between the user's `_final` body and
        // whatever code runs right after `end()` returns.
        this.emitNoArgFrom(c, ROOT, "prefinish", ARGS);
        c.localGet(ROOT);
        c.i32Const(OP_FINISH);
        c.call(this.scheduleTickPublic());
        this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef()], c.bytes());
      },
    );
  }

  /* STAGE C PASS 2, Transform's `_transform` completion-callback landing
   * (emitter.ts's `doneClosFor`/`dynDoneClosFor` "transform" kind) used
   * to live here as its own `afterTransformCore` function: `data`
   * arrives ALREADY EXTRACTED (doneClosFor's own union-arm read — the
   * completion callback's real declared type, per the project-local
   * ambient, is a CONCRETE `Buffer | string | undefined` union, never
   * `dyn`, so a real wasm `null` means "no data" directly, no dyn-UNDEF
   * sentinel needed); measured directly against Node (p3a/p3c/p3d/p3g):
   * an error skips data entirely and takes the SAME path a plain
   * `_write` callback error already does; success pushes `data` (if
   * non-null — `cb()`/`cb(null, undefined)` pushes nothing, T5's own
   * pin), then falls into the SAME completion `_write` uses. FIX ROUND
   * CONTINUATION (P2-1, probe08) folded this directly into
   * `writeDoneLandingCore`, below, rather than calling it as a separate
   * step — the push must happen BEFORE the WS_SYNC-gated defer decision,
   * not bundled with the (possibly deferred) completion the way this
   * function bundled them; `writeDoneLandingCore`'s own header has the
   * measured mechanism. Whether a data-bearing error (`cb(err, data)`)
   * should still push before erroring is UNMEASURED — this (like the
   * function it replaced) skips data on any error, named per the
   * sibling rule, not exercised by any claim. */

  /* ── FIX ROUND (P2-1, gate finding): the sync-write-completion defer ──
   *
   * MEASURED (node v24.18.1, `node -e`), not assumed: a `_write`
   * callback invoked SYNCHRONOUSLY — before `_write` itself returns —
   * does NOT continue synchronously into the stream's own completion
   * handling (drain/'error'/'close' etc). Node's real `onwrite` checks
   * `state.sync` and, when true, defers via `process.nextTick` instead
   * of calling `afterWrite`/the error path inline:
   *   w.write('x', () => console.log('write-cb'));  // sync _write, sync cb(err|undefined)
   *   console.log('after write() returns');
   * prints "after write() returns" BEFORE "write-cb" every time — the
   * completion is on a LATER turn, never inline, for BOTH the success
   * and error shapes (re-measured for the error shape too — an 'error'
   * listener attached to a stream whose `_write` calls `cb(err)`
   * synchronously fires strictly after the script's own synchronous
   * continuation, interleaved with `process.nextTick` order).
   *
   * This file's OWN `doWriteCore` already tracks the identical window
   * via WS_SYNC (set true immediately before `callRef(writeThunkSig())`,
   * reset false immediately after) — it was write-only state until this
   * fix; nothing ever read it back. `writeDoneLandingCore`, below, is
   * the SHARED landing `doneClosFor`'s own "write"/"transform" kinds
   * now call (emitter.ts) INSTEAD OF `afterWriteCore` directly: WS_SYNC
   * true (still inside the synchronous `_write`/
   * `_transform` window) defers by ONE tick via `scheduleWriteCompletion`;
   * WS_SYNC false (the callback fired on some LATER turn, having
   * already yielded control back to the event loop on its own) calls
   * the target directly, Node's own `else` branch, this file's
   * pre-existing behavior unchanged.
   *
   * THIS IS THE ROOT CAUSE of the gate's teardown-order finding, not a
   * pipeline-specific bug: `_read()` pushing a chunk then `push(null)`
   * (ONE synchronous call, both statements back to back) drove the
   * WHOLE downstream chain — pipe's ondata thunk, a Transform's
   * `_transform`, a Writable's `_write`, an erroring `cb(err)` —
   * synchronously to completion (destroy, `scheduleTick(OP_ERROR)`,
   * `scheduleTick(OP_CLOSE)`) BEFORE `push(null)` itself ever ran, so
   * the erroring stage's own teardown got appended to the shared $rTick
   * FIFO ahead of the clean-finishing source's OWN `opEnd`-triggered
   * `OP_CLOSE` — even though the source's natural completion is
   * chronologically FIRST in the user's own source order. With this
   * fix, the erroring stage's `_write`/`_transform` callback (itself
   * invoked synchronously, from deep inside that same nested call)
   * defers its OWN continuation by a tick, letting `push(null)`'s own
   * `opEnd` run and schedule the source's `OP_CLOSE` FIRST — exactly
   * mirroring Node. Nothing here is a pipeline mechanism at all: no
   * ordering RULE was added anywhere in stream.ts for this — the
   * corrected relative order is an emergent property of restoring the
   * ONE missing tick Node's own write path has, the same "let the real
   * mechanism produce the order" discipline `pipelineFinishImpl`'s own
   * header already documents for the OTHER half of this file.
   *
   * FIX ROUND CONTINUATION (still P2-1, gate finding probe08): the
   * defer above is necessary but was not SUFFICIENT — it was deferring
   * TWO things Node keeps separate. MEASURED (node v24.18.1, `node -e`,
   * a Transform piped to an instrumented Writable): a `_transform`
   * callback's PUSH to the readable side (and that push's own
   * synchronous flow to whatever consumes it — e.g. a piped downstream
   * `write()`) happens IMMEDIATELY, inside the `cb(err, data)` call
   * itself, before `cb()` even returns. Only the WRITE-COMPLETION
   * notification (the thing that signals backpressure/drain back to
   * whoever wrote INTO the transform) defers via nextTick — the SAME
   * `state.sync` check documented above, but scoped to completion only.
   * `afterTransformCore` (removed by this continuation) bundled push
   * and completion into one call, so deferring "the completion" via
   * `scheduleWriteCompletion`/`dispatchWriteCompletion` deferred the
   * push too — giving an upstream source room to race ahead with its
   * OWN next `_read()` before a downstream Writable ever saw the
   * transformed chunk (probe08's exact divergence: Node's real
   * interleave is `...t._transform:p1, w._write#1:p1, s._read#3...`;
   * this file's pre-continuation interleave was
   * `...t._transform:p1, s._read#3, w._write#1:p1...`). `writeDoneLandingCore`,
   * below, now does the push UNCONDITIONALLY and IMMEDIATELY (guarded
   * only on `data != null` — a `cb(null)` filtering transform with no
   * data must never `push(null)`, which means EOF, not "nothing to
   * push"; NAMED SIBLING: no corpus claim exercises a filtering
   * transform that drops a chunk this way — see
   * wasm-stream-pipeline.test.ts's own filtering-transform pin, added
   * alongside this fix specifically because the guard's correctness
   * otherwise rides on the Node measurement alone, unexercised) —
   * BEFORE the WS_SYNC-gated defer decision, which now governs ONLY the
   * completion notification, identical for the write and transform
   * kinds (both are just `afterWriteCore(root, err)` now — no kind
   * branch survives on the completion side at all, which is why
   * `afterTransformCore` has no remaining callers and was deleted
   * rather than left as dead code). Two OTHER call sites bundled
   * push+completion the same way `afterTransformCore` did and needed
   * the same correction: `dynDoneClosFor`'s "transform" kind
   * (emitter.ts) now routes through `writeDoneLandingCore` too, exactly
   * mirroring `doneClosFor`'s own already-fixed "transform" kind — it
   * was NOT fixed when `doneClosFor` was, a gap discovered only while
   * removing `afterTransformCore`'s last callers. NAMED SIBLING, NOT
   * FIXED HERE: `dynDoneClosFor`'s "write" kind still calls
   * `afterWriteCore()` directly, ungated by WS_SYNC, exactly as before
   * this whole fix round — a dyn-typed `write(chunk, enc, cb)` override
   * may have the SAME q9/q10-class teardown-order bug the typed write
   * path had before the WS_SYNC_ERRORED fix; out of this round's
   * authorized scope, reported not silently patched. NAMED SIBLING, NOT
   * FIXED HERE: `identityTransformThunk` (PassThrough's own default
   * `_transform`, below) already pushed synchronously before this
   * continuation (never needed the push-timing fix) but its completion
   * call was NEVER routed through the WS_SYNC-gated defer at all —
   * it calls `afterWriteCore` directly, unconditionally, same as
   * before. A bare PassThrough's completion is therefore never
   * deferred even when called synchronously; 1814's own `mid` stage
   * IS a bare PassThrough and stays byte-exact regardless (verified),
   * so this is a real but currently-unexercised gap, not a known
   * failure — left untouched, out of scope. */

  private writeCompletionT(): number {
    if (this.writeCompletionTField !== null) return this.writeCompletionTField;
    const rootRef = this.deps.rootRef();
    const errRef = this.deps.errRef();
    // FIX ROUND (P2-1 continuation, layer 3): this record used to also
    // carry DATA/IS_TRANSFORM so the dequeue side could re-dispatch to
    // `afterTransformCore` — removed along with that function. The push
    // half now happens synchronously at `writeDoneLandingCore`'s OWN
    // call time (never deferred, per this section's header).
    //
    // LAYER 5 (afterWriteCore split): re-added WCT_CB_CLOS — the bare
    // (root, err) landing above stopped being enough once the completed
    // write's own bookkeeping (pop/decrement/clear-writing) moved to the
    // ALWAYS-IMMEDIATE `afterWriteHeadCore`, which now runs BEFORE this
    // record is even enqueued and captures the completed WREQ's own
    // callback closure — the tail (whichever of `afterWriteCore`'s two
    // call sites eventually fires) needs that value threaded through,
    // since it no longer has the WREQ itself to read it from.
    this.writeCompletionTField = this.mb.selfStructType("%w.ws.writeCompletion", (self) => [
      { storage: rootRef, mutable: false }, // WCT_ROOT
      { storage: errRef, mutable: false }, // WCT_ERR
      { storage: { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }, mutable: false }, // WCT_CB_CLOS
      { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true }, // WCT_NEXT
    ]);
    return this.writeCompletionTField;
  }

  private writeCompletionRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.writeCompletionT() };
  }

  private writeCompletionQueue(): { head: number; tail: number } {
    if (this.writeCompletionQueueField === null) {
      const t = this.writeCompletionRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0); // ref.null $w.ws.writeCompletion
        w.sleb(this.writeCompletionT());
      };
      this.writeCompletionQueueField = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.writeCompletionQueueField;
  }

  /** `(root, err, cbClos) -> void` — appends a deferred completion
   * record and posts the SAME `enqueueRaw()`/nexttick.ts seam
   * `scheduleTick()`/`schedulePipelineFinal()` use, so it interleaves
   * correctly against user nextTicks and every OTHER deferred stream
   * tick — `pipelineTick`'s own precedent, ported for this file's other
   * genuinely distinct work-item shape. */
  private scheduleWriteCompletion(): number {
    return this.cachedRecursive(
      "scheduleWriteCompletion",
      () =>
        this.mb.declareFunc(
          this.mb.funcType(
            [this.deps.rootRef(), this.deps.errRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
            [],
          ),
          "%w.ws.scheduleWriteCompletion",
        ),
      (idx) => {
        const q = this.writeCompletionQueue();
        const c = new Code();
        const ROOT = 0, ERR = 1, CBCLOS = 2, N = 3;
        c.localGet(ROOT);
        c.localGet(ERR);
        c.localGet(CBCLOS);
        c.refNull(this.writeCompletionT());
        c.structNew(this.writeCompletionT());
        c.localSet(N);
        c.globalGet(q.tail);
        c.refIsNull();
        c.ifVoid();
        c.localGet(N);
        c.globalSet(q.head);
        c.else_();
        c.globalGet(q.tail);
        c.localGet(N);
        c.structSet(this.writeCompletionT(), WCT_NEXT);
        c.end();
        c.localGet(N);
        c.globalSet(q.tail);
        this.mb.declareFuncRef(this.dispatchWriteCompletion());
        c.refFunc(this.dispatchWriteCompletion());
        c.call(this.deps.enqueueRaw());
        this.mb.setBody(idx, [this.writeCompletionRef()], c.bytes());
      },
    );
  }

  /** `() -> ()` — the raw marker's target: pops ONE completion record
   * and lands it on `afterWriteCore` (the tail — bookkeeping already ran
   * in `afterWriteHeadCore` before this record was even enqueued, this
   * section's own header has the full measured mechanism story). */
  private dispatchWriteCompletion(): number {
    return this.cachedRecursive(
      "dispatchWriteCompletion",
      () => this.mb.declareFunc(this.deps.rawFnType(), "%w.ws.dispatchWriteCompletion"),
      (idx) => {
        const q = this.writeCompletionQueue();
        const c = new Code();
        const N = 0, ROOT = 1, ERR = 2, CBCLOS = 3;
        c.globalGet(q.head);
        c.localSet(N);
        c.localGet(N);
        c.structGet(this.writeCompletionT(), WCT_NEXT);
        c.globalSet(q.head);
        c.globalGet(q.head);
        c.refIsNull();
        c.ifVoid();
        c.refNull(this.writeCompletionT());
        c.globalSet(q.tail);
        c.end();
        c.localGet(N);
        c.refNull(this.writeCompletionT());
        c.structSet(this.writeCompletionT(), WCT_NEXT);
        c.localGet(N);
        c.structGet(this.writeCompletionT(), WCT_ROOT);
        c.localSet(ROOT);
        c.localGet(N);
        c.structGet(this.writeCompletionT(), WCT_ERR);
        c.localSet(ERR);
        c.localGet(N);
        c.structGet(this.writeCompletionT(), WCT_CB_CLOS);
        c.localSet(CBCLOS);
        c.localGet(ROOT);
        c.localGet(ERR);
        c.localGet(CBCLOS);
        c.call(this.afterWriteCore());
        this.mb.setBody(
          idx,
          [this.writeCompletionRef(), this.deps.rootRef(), this.deps.errRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
          c.bytes(),
        );
      },
    );
  }

  /** `(root, err, data, isTransform: i32) -> void` — PUBLIC: the shared
   * landing `doneClosFor`'s "write"/"transform" kinds call instead of
   * `afterWriteCore` directly (emitter.ts). This section's own header
   * has the full measured mechanism story — the WS_SYNC_ERRORED flag,
   * the push/completion split, and (afterWriteCore's own header) the
   * queue-continuation/completion-tail split. */
  writeDoneLandingCore(): number {
    return this.cachedRecursive(
      "writeDoneLandingCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef(), this.deps.errRef(), this.deps.bytesRef(), I32], []), "%w.ws.writeDoneLanding"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ERR = 1, DATA = 2, ISXFORM = 3, ST = 4, CBCLOS = 5, NEEDTICK = 6;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        // FIX ROUND (P2-1): mark WS_SYNC_ERRORED IMMEDIATELY, before the
        // WS_SYNC-gated defer decision below — visible to writeCore's own
        // return-value formula the instant doWriteCore() returns, exactly
        // mirroring Node's own state.errored (WS_SYNC_ERRORED's own
        // header has the full measured story).
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_SYNC_ERRORED);
        c.end();
        // FIX ROUND CONTINUATION (P2-1, probe08): the push half of a
        // transform's completion is NEVER deferred — Node's own
        // `_transform` callback pushes to the readable side (and flows
        // synchronously to whatever consumes it) inside the callback
        // itself, decoupled from the write-completion notification below
        // (this section's own header has the measured A/B probe). Guard
        // on `data != null`: a `cb(null)` filtering transform with no
        // data must fall through to nothing here, NOT `pushCore(null)` —
        // that means EOF, not "no chunk this time" (wasm-stream-pipeline
        // .test.ts's filtering-transform pin exercises exactly this).
        c.localGet(ISXFORM);
        c.ifVoid();
        c.localGet(ERR);
        c.refIsNull();
        c.ifVoid();
        c.localGet(DATA);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.localGet(ROOT);
        c.localGet(DATA);
        c.i32Const(0); // front: false — an ordinary tail push
        c.call(this.pushCore());
        c.drop(); // same as the old afterTransformCore: the should-push-more answer is not observed here
        c.end();
        c.end();
        c.end();
        // LAYER 5 (afterWriteCore split): the ALWAYS-IMMEDIATE half —
        // bookkeeping + (unless this is a fresh error) the next queued
        // entry's own dispatch — runs UNCONDITIONALLY here, before any
        // defer decision. afterWriteHeadCore's own header has the
        // measured mechanism; this is what fixes probe08's residual.
        c.localGet(ROOT);
        c.localGet(ERR);
        c.call(this.afterWriteHeadCore());
        c.localSet(CBCLOS);
        // The REMAINING tail (afterWriteCore) is what stays behind a
        // defer gate — for an ERROR, the SAME bare WS_SYNC gate as
        // before (Node's onwriteError: wholesale-deferred whenever
        // sync, no needTick refinement — afterWriteCore's own header).
        // For SUCCESS, the gate is WS_SYNC && needTick, the ported
        // condition (afterWriteCore's own header cites the source lines
        // and flags the RS_DESTROYED clause as approximated-by-intent).
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.ifVoid();
        c.i32Const(1); // error: needTick is moot, the gate is bare WS_SYNC
        c.localSet(NEEDTICK);
        c.else_();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_NEED_DRAIN);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_LENGTH);
        c.f64Const(0);
        c.f64Eq();
        c.i32And();
        c.localGet(ST);
        c.structGet(this.stateT(), RS_DESTROYED);
        c.i32Or();
        c.localGet(CBCLOS);
        c.refIsNull();
        c.i32Eqz();
        c.i32Or();
        c.localSet(NEEDTICK);
        c.end();
        c.localGet(ST);
        c.structGet(this.stateT(), WS_SYNC);
        c.localGet(NEEDTICK);
        c.i32And();
        c.ifVoid();
        c.localGet(ROOT);
        c.localGet(ERR);
        c.localGet(CBCLOS);
        c.call(this.scheduleWriteCompletion());
        c.else_();
        c.localGet(ROOT);
        c.localGet(ERR);
        c.localGet(CBCLOS);
        c.call(this.afterWriteCore());
        c.end();
        this.mb.setBody(
          idx,
          [this.stateRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }, I32],
          c.bytes(),
        );
      },
    );
  }

  /** `(root, errRef|null, bytesRef|null) -> void` — STAGE C PASS 2,
   * Transform: `_flush`'s completion-callback landing site. `data`
   * arrives already-extracted (doneClosFor's own union-arm read — see
   * `writeDoneLandingCore`'s own header for the full correction story on
   * the sibling "transform" kind). Measured directly against Node
   * (p3b/p3f/p3g/p3h — your own trace, `T6.final [as _final]`): `_flush`
   * interposes as Transform's OWN internal `_final` (the construction
   * side populates WS_FINAL_CLOS/THUNK with a bridge to the user's
   * `_flush`, NOT an event listener), so its error takes `_final`'s
   * existing error path (`finalDoneCore`'s own `destroyErrCore` branch),
   * unchanged. Success: push `data` if present (already bytes, no
   * coercion here), UNCONDITIONALLY push(null) (ends
   * the readable side — Node does this whether or not `_flush` was even
   * defined, p3e's PassThrough-with-no-_flush pin), THEN `finalDoneCore`
   * — which is what fires 'prefinish' AND schedules 'finish'. Ordering
   * measured, not assumed: p3g shows the flush-pushed 'data' event
   * landing BEFORE 'prefinish' in real Node, and `finalDoneCore` firing
   * 'prefinish' only AFTER this function's own push-then-null-then-call
   * sequence reproduces that order for free — no divergence to name
   * here. */
  flushDoneCore(): number {
    return this.cached("flushDoneCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root, this.deps.errRef(), this.deps.bytesRef()], []), "%w.ws.flushDone");
      const c = new Code();
      const ROOT = 0, ERR = 1, DATA = 2;
      c.localGet(ERR);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(ERR);
      c.call(this.finalDoneCore());
      c.return_();
      c.end();
      c.localGet(DATA);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(ROOT);
      c.localGet(DATA);
      c.i32Const(0);
      c.call(this.pushCore());
      c.drop();
      c.end();
      c.localGet(ROOT);
      c.call(this.pushNullCore());
      c.drop(); // pushNullCore's own i32 answer is always false (its own header) — nothing to observe
      c.localGet(ROOT);
      c.refNull(this.errType());
      c.call(this.finalDoneCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(clos, this, chunk, encoding, wreq) -> void` — `writeThunkSig()`'s
   * exact shape (WS_WRITE_THUNK's slot): PassThrough's OWN identity
   * `_transform` when the construction site provides no user override
   * (Node's real `PassThrough` — checked directly against @types/node's
   * structural shape, and p3d/p3e's own pin — is exactly `_transform(c,
   * e, cb) { cb(null, c); }`). `chunk` is ALREADY bytes (this file's own
   * chunk representation), so this pushes it straight through — no
   * dyn-boxing round trip needed at all, unlike a real user override's
   * dyn-typed completion-callback data slot. */
  identityTransformThunk(): number {
    return this.cached("identityTransformThunk", () => {
      const idx = this.mb.declareFunc(this.writeThunkSig(), "%w.ws.identityTransformThunk");
      const c = new Code();
      const CLOS = 0, THIS = 1, CHUNK = 2, ENC = 3, WREQ = 4;
      c.localGet(THIS);
      c.localGet(CHUNK);
      c.i32Const(0); // front: false
      c.call(this.pushCore());
      c.drop();
      // NAMED SIBLING (P2-1 continuation, NOT fixed here): this already
      // pushed synchronously above (never needed the push-timing fix —
      // it never bundled push with completion the way afterTransformCore
      // did), so the removal of that function is a pure mechanical
      // substitution here — err/data were always null on this path
      // (afterTransformCore's own null-data branch was a no-op). LAYER 5:
      // afterWriteCore no longer does its own bookkeeping (pop/decrement
      // /clear-writing) — that moved to afterWriteHeadCore — so this MUST
      // call both now, or a bare PassThrough would silently stop
      // advancing its own write queue at all. Both calls stay
      // UNCONDITIONAL/immediate here, UNGATED by WS_SYNC — a bare
      // PassThrough's completion is still never deferred, unlike a
      // user-supplied _write/_transform's (routed through
      // writeDoneLandingCore, emitter.ts's doneClosFor). Out of this
      // round's authorized scope; this section's own header has the full
      // note (1814's own `mid` stage IS a bare PassThrough and stays
      // byte-exact regardless — verified, not just assumed).
      const CBCLOS = 5;
      c.localGet(THIS);
      c.refNull(this.errType());
      c.call(this.afterWriteHeadCore());
      c.localSet(CBCLOS);
      c.localGet(THIS);
      c.refNull(this.errType());
      c.localGet(CBCLOS);
      c.call(this.afterWriteCore());
      this.mb.setBody(idx, [{ kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }], c.bytes());
      return idx;
    });
  }

  /** `(clos, this) -> void` — `finalThunkSig()`'s exact shape
   * (WS_FINAL_THUNK's slot): every Transform/PassThrough construction
   * needs SOME bridge here regardless of whether the program supplied a
   * `_flush` override — Node's real internal `_final` (`final` in
   * transform.js) ALWAYS runs the push(null)-then-finish sequence, with
   * or without a `_flush` (measured directly, p3e: a bare `PassThrough`
   * with no `_flush` at all still cycles prefinish→end→finish cleanly,
   * nothing extra pushed). Reuses `flushDoneCore` directly with a null
   * error and null data — its own "no data to push" branch already skips
   * straight to the unconditional push(null) + `finalDoneCore` tail. */
  identityFlushThunk(): number {
    return this.cached("identityFlushThunk", () => {
      const idx = this.mb.declareFunc(this.finalThunkSig(), "%w.ws.identityFlushThunk");
      const c = new Code();
      const CLOS = 0, THIS = 1;
      c.localGet(THIS);
      c.refNull(this.errType());
      c.refNull(this.deps.bytesStructType());
      c.call(this.flushDoneCore());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(clos, argsVec) -> dyn` — `deps.thunkSig()`'s exact shape: the
   * BUILD RULING's genuine no-op 'prefinish' listener Transform/
   * PassThrough construction registers on itself, ported from Node's
   * real `internal/streams/transform.js` (fetched directly, v24.18.1,
   * matching this environment's own `node -v`): `this.on('prefinish',
   * prefinish)`, a backward-compat shim for pre-`_flush` code that
   * overrode `_final` directly. `prefinish()`'s body — `if (this._final
   * !== final) { final.call(this); }` — is PROVABLY dead in this tier
   * (lower-classes.ts's own underscore-method fence hard-refuses any
   * Transform/PassThrough subclass declaring `_final`, since "final" is
   * not in either class's `accepted` list, SC1090) — so this thunk does
   * nothing at all, ever; it exists ONLY so eventNames()/listenerCount/
   * rawListeners/removeAllListeners('prefinish') see the SAME single
   * real entry Node's own construction leaves behind (p3j/p3k's own
   * measurements — a fresh instance's eventNames() === ["prefinish"],
   * listenerCount === 1, and removeAllListeners('prefinish') empties it
   * exactly like any other real entry, matching Node byte-for-byte). */
  prefinishShimThunk(): number {
    return this.cached("prefinishShimThunk", () => {
      const idx = this.mb.declareFunc(this.deps.thunkSig(), "%w.rs.prefinishShim");
      const c = new Code();
      c.globalGet(this.deps.undefinedDynGlobal());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** 'drain' — OP_DRAIN's tick body (Node's real `onwriteDrain`, folded
   * into the scheduled form every deferred emission here uses). */
  private opDrain(): number {
    return this.cached("opDrain", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.opDrain");
      const c = new Code();
      const ROOT = 0, ARGS = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_LENGTH);
      c.f64Const(0);
      c.f64Eq();
      c.ifVoid();
      this.emitNoArgFrom(c, ROOT, "drain", ARGS);
      c.end();
      this.mb.setBody(idx, [this.deps.dynArrRef()], c.bytes());
      return idx;
    });
  }

  /** 'finish' — OP_FINISH's tick body: the `end(cb)` callback (BEFORE
   * 'finish' listeners — 1688/1741/1811's pin), the 'finish' event
   * itself, then autoDestroy's own default-path destroy (already built —
   * pass 1's `destroyCore`, which drives 'close' exactly as a Readable's
   * does).
   *
   * CORRECTION (1690, both-sides autoDestroy): pass 1 built this for the
   * single-sided Writable only, where 'finish' is the WHOLE lifecycle —
   * destroying immediately after is correct there and stays unchanged.
   * A duplex-shaped stream (WS_DUPLEX_SHAPED) has a second, independent
   * half that may still be open; Node's real autoDestroy waits for BOTH
   * `_writableState.finished` AND `_readableState.endEmitted` before
   * actually destroying (measured, order-independent — WS_DUPLEX_SHAPED's
   * own header, p6a/p6b). `opEnd`'s own mirror check is the other half
   * of this same gate — whichever side completes SECOND is the one that
   * actually fires the destroy. */
  private opFinish(): number {
    return this.cached("opFinish", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.opFinish");
      const c = new Code();
      const ROOT = 0, ST = 1, ARGS = 2, CB = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_FINISHED);
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ST);
      c.i32Const(1);
      c.structSet(this.stateT(), WS_FINISHED);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_END_CLOS);
      c.localTee(CB);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(CB); // arg0: the closure itself (call_ref wants args, THEN the funcref)
      c.localGet(CB);
      c.structGet(this.deps.voidClos().clos, 0);
      c.callRef(this.deps.voidClos().fn);
      c.end();
      this.emitNoArgFrom(c, ROOT, "finish", ARGS);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_AUTO_DESTROY);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DUPLEX_SHAPED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Or();
      c.i32And();
      c.ifVoid();
      c.localGet(ROOT);
      c.call(this.destroyCore());
      c.end();
      this.mb.setBody(idx, [this.stateRef(), this.deps.dynArrRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — OP_AUTO_END's tick body: Node's real
   * `endWritableNT`, ported (OP_AUTO_END's own header has the full
   * mechanism story). Re-checks the SAME four flags `opEnd`'s branch-
   * selection guard already tested (state can move in the tick gap:
   * user code, or another already-queued tick, running between
   * scheduling and this firing), then calls `endCore` exactly like
   * `pipeOnendThunk`'s own `dest.end()` — null chunk, no callback, the
   * SAME "just end it" shape. A guard failure here is a quiet no-op,
   * matching Node's own `if (writable) { stream.end(); }` — there is
   * nothing to report, `.end()` simply never runs a second time. */
  private opAutoEnd(): number {
    return this.cached("opAutoEnd", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.opAutoEnd");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDING);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Or();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32Eqz();
      c.i32Or();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ROOT);
      c.refNull(this.deps.bytesStructType());
      c.i32Const(0); // hasChunk
      c.refNull(this.deps.voidClos().clos);
      c.i32Const(0); // hasCb
      c.call(this.endCore());
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(state, sublist) -> void` — GATE FIX C2/C4: appends an already-
   * linked `$wReq` chain (possibly one node) to WS_DISCARDED's tail,
   * walking to find it (no separate tail field — this list is a rare,
   * deferred-maintenance path, unlike WS_HEAD/TAIL's O(1) append). A
   * null `sublist` is a safe no-op. */
  private wsDiscardAppend(): number {
    return this.cached("wsDiscardAppend", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.stateRef(), this.wReqRef()], []), "%w.ws.discardAppend");
      const c = new Code();
      const ST = 0, SUB = 1, CUR = 2;
      c.localGet(SUB);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DISCARDED);
      c.refIsNull();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(SUB);
      c.structSet(this.stateT(), WS_DISCARDED);
      c.return_();
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DISCARDED);
      c.localSet(CUR);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      c.localGet(CUR);
      c.localGet(SUB);
      c.structSet(this.wReqT(), WREQ_NEXT);
      this.mb.setBody(idx, [this.wReqRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — GATE FIX C4: on destroy, stop dispatching and
   * discard whatever is QUEUED (not yet in flight): if a write IS
   * currently in flight (WS_WRITING), its own already-running `_write`
   * call is left alone (Node cannot un-call a JS function that already
   * started — c-destroy-cbfate2.cjs's own "one"'s callback still fires,
   * with no error, exactly as its own `setTimeout` scheduled) — only
   * WS_HEAD's OWN `next` chain (the genuinely queued entries) transfers
   * to WS_DISCARDED. If nothing is in flight, WS_HEAD itself was never
   * dispatched, so the WHOLE chain discards. Either way WS_HEAD/TAIL end
   * up describing only what remains eligible to reach `_write` (nothing,
   * post-destroy — `doWriteCore`'s own `RS_DESTROYED`-adjacent callers
   * never fire again once destroyed). Called from `destroyErrDefaultCore`
   * AFTER it schedules OP_CLOSE. GATE FIX C4 v2 (BLOCKING, measured:
   * c-destroy-cbfate.ts — "cb one" THEN "cb two", never the reverse):
   * the discarded entries' own callbacks fire from OP_FIRE_DISCARDED,
   * but WHEN it gets scheduled now depends on which branch ran here —
   * immediately (still after OP_CLOSE) when NOTHING was in flight
   * (nothing to wait for), or deferred to `afterWriteCore`'s own tail
   * when something WAS (chained after that entry's real, eventual
   * completion callback — never an independently-scheduled tick racing
   * ahead of it). See `destroyErrDefaultCore`'s and `afterWriteCore`'s
   * own comments for the two halves. */
  private discardQueueCore(): number {
    return this.cached("discardQueueCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.discardQueue");
      const c = new Code();
      const ROOT = 0, ST = 1, SUB = 2;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.refIsNull();
      c.ifVoid();
      c.return_(); // nothing queued at all
      c.end();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_WRITING);
      c.ifVoid();
      // In flight: keep WS_HEAD, discard its `next` onward.
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.localSet(SUB);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.refNull(this.wReqT());
      c.structSet(this.wReqT(), WREQ_NEXT);
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.structSet(this.stateT(), WS_TAIL); // tail is now the (still in-flight) head
      c.else_();
      // Nothing in flight: the whole chain was never dispatched.
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.localSet(SUB);
      c.localGet(ST);
      c.refNull(this.wReqT());
      c.structSet(this.stateT(), WS_HEAD);
      c.localGet(ST);
      c.refNull(this.wReqT());
      c.structSet(this.stateT(), WS_TAIL);
      c.end();
      c.localGet(ST);
      c.localGet(SUB);
      c.call(this.wsDiscardAppend());
      this.mb.setBody(idx, [this.stateRef(), this.wReqRef()], c.bytes());
      return idx;
    });
  }

  /** OP_FIRE_DISCARDED's tick body — see WS_DISCARDED's own header for
   * why no error value is threaded through the (zero-arg) callback. */
  private opFireDiscarded(): number {
    return this.cached("opFireDiscarded", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.opFireDiscarded");
      const c = new Code();
      const ROOT = 0, ST = 1, CUR = 2, CBCLOS = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_DISCARDED);
      c.localSet(CUR);
      c.localGet(ST);
      c.refNull(this.wReqT());
      c.structSet(this.stateT(), WS_DISCARDED);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_CB_CLOS);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_CB_CLOS);
      c.localSet(CBCLOS);
      c.localGet(CBCLOS); // arg0 (call_ref wants args, THEN the funcref)
      c.localGet(CBCLOS);
      c.structGet(this.deps.voidClos().clos, 0);
      c.callRef(this.deps.voidClos().fn);
      c.end();
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      this.mb.setBody(
        idx,
        [this.stateRef(), this.wReqRef(), { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos }],
        c.bytes(),
      );
      return idx;
    });
  }

  /** `(root) -> void` — `cork()`: bumps the (count, not bool) cork
   * level. */
  corkCore(): number {
    return this.cached("corkCore", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], []), "%w.ws.cork");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_CORKED);
      c.f64Const(1);
      c.f64Add();
      c.structSet(this.stateT(), WS_CORKED);
      // GATE FIX C1 (BLOCKING): the locals array was `[]`, but the body
      // declares/uses local 1 (ST) via localSet/localGet — an undeclared
      // local, invalid wasm ("invalid local index: 1" at instantiate
      // time, board #20's class). ST is a `stateRef()`-typed scratch, the
      // one extra local this function actually needs.
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> void` — `uncork()`: drops the cork level (floored at 0 —
   * an extra uncork() past the last cork() is a harmless no-op, Node's
   * own behavior) and, once it reaches 0, kicks the queue. */
  uncorkCore(): number {
    return this.cachedRecursive(
      "uncorkCore",
      () => this.mb.declareFunc(this.mb.funcType([this.deps.rootRef()], []), "%w.ws.uncork"),
      (idx) => {
        const c = new Code();
        const ROOT = 0, ST = 1;
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_CORKED);
        c.f64Const(0);
        c.f64Gt();
        c.ifVoid();
        c.localGet(ST);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_CORKED);
        c.f64Const(1);
        c.f64Sub();
        c.structSet(this.stateT(), WS_CORKED);
        c.localGet(ST);
        c.structGet(this.stateT(), WS_CORKED);
        c.f64Const(0);
        c.f64Eq();
        c.ifVoid();
        c.localGet(ROOT);
        c.call(this.doWriteCore());
        c.end();
        c.end();
        this.mb.setBody(idx, [this.stateRef()], c.bytes());
      },
    );
  }

  /** `(root, flags: i32, chunk?, cb?: voidClos|null) -> void` — `end()`'s
   * core: an optional tail chunk rides `writeCore` (Node's own `end()`
   * calls `write()` for the tail), an optional callback binds as
   * WS_END_CLOS, then `ending` flips and `maybeFinishCore` tries to
   * finish immediately (the common case: nothing was ever in flight). */
  endCore(): number {
    return this.cachedRecursive(
      "endCore",
      () =>
        this.mb.declareFunc(
          this.mb.funcType(
            [
              this.deps.rootRef(),
              this.deps.bytesRef(),
              I32, // hasChunk
              { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos },
              I32, // hasCb
            ],
            [],
          ),
          "%w.ws.end",
        ),
      (idx) => {
        const c = new Code();
        const ROOT = 0, CHUNK = 1, HAS_CHUNK = 2, CB = 3, HAS_CB = 4, ST = 5;
        c.localGet(HAS_CHUNK);
        c.ifVoid();
        c.localGet(ROOT);
        c.localGet(CHUNK);
        c.refNull(this.deps.voidClos().clos);
        c.call(this.writeCore());
        c.drop();
        c.end();
        c.localGet(ROOT);
        c.call(this.stateEnsure());
        c.localSet(ST);
        c.localGet(HAS_CB);
        c.ifVoid();
        c.localGet(ST);
        c.localGet(CB);
        c.structSet(this.stateT(), WS_END_CLOS);
        c.end();
        c.localGet(ST);
        c.i32Const(1);
        c.structSet(this.stateT(), WS_ENDING);
        c.localGet(ROOT);
        c.call(this.maybeFinishCore());
        this.mb.setBody(idx, [this.stateRef()], c.bytes());
      },
    );
  }

  /* ── writable-side state getters (stream.prop's WS_* names) ─────────── */

  wsLengthOf(): number {
    return this.cached("wsLengthOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.ws.length");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_LENGTH);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  wsHwmOf(): number {
    return this.cached("wsHwmOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.ws.hwm");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_HWM);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  wsCorkedOf(): number {
    return this.cached("wsCorkedOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.ws.corked");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_CORKED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — the queued-request COUNT (Node's real
   * `bufferedRequestCount`): the head-of-queue entry that's actually IN
   * FLIGHT (WS_WRITING) does not count (Node's `state.buffered` excludes
   * it — only the entries BEHIND it do), so this walks past one entry
   * first when writing is true. */
  wsBufferedRequestCountOf(): number {
    return this.cached("wsBufferedRequestCountOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [F64]), "%w.ws.bufferedRequestCount");
      const c = new Code();
      const ROOT = 0, ST = 1, CUR = 2, N = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_HEAD);
      c.localSet(CUR);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_WRITING);
      c.ifVoid();
      c.localGet(CUR);
      c.refIsNull();
      c.ifVoid();
      c.else_();
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.localSet(CUR);
      c.end();
      c.end();
      c.f64Const(0);
      c.localSet(N);
      c.block();
      c.loop();
      c.localGet(CUR);
      c.refIsNull();
      c.brIf(1);
      c.localGet(N);
      c.f64Const(1);
      c.f64Add();
      c.localSet(N);
      c.localGet(CUR);
      c.structGet(this.wReqT(), WREQ_NEXT);
      c.localSet(CUR);
      c.br(0);
      c.end();
      c.end();
      c.localGet(N);
      this.mb.setBody(idx, [this.stateRef(), this.wReqRef(), F64], c.bytes());
      return idx;
    });
  }

  writableEndingOf(): number {
    return this.cached("writableEndingOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.ending");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_ENDING);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  writableEndedInternalOf(): number {
    return this.cached("writableEndedInternalOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.endedInternal");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_ENDED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  writableFinishedOf(): number {
    return this.cached("writableFinishedOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.finished");
      const c = new Code();
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_FINISHED);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  writableNeedDrainOf(): number {
    return this.cached("writableNeedDrainOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.needDrain");
      const c = new Code();
      // Node's real `writableNeedDrain` getter: `length >= highWaterMark`
      // (a live recomputation, not a stored bit — this tier doesn't keep
      // a separate needDrain flag observable from JS; OP_DRAIN's own
      // scheduling condition, `length === 0`, is a DIFFERENT internal
      // trigger and not what this getter reports).
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_LENGTH);
      c.localGet(0);
      c.call(this.stateEnsure());
      c.structGet(this.stateT(), WS_HWM);
      c.f64Ge();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — the top-level `.writable` getter (Node's real
   * shape: alive, not destroyed/errored, and not yet ending/ended). */
  writableOf(): number {
    return this.cached("writableOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.writable");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDING);
      c.i32Eqz();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ENDED);
      c.i32Eqz();
      c.i32And();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — STAGE C PASS 2, Transform (CORRECTION ruling C):
   * `.allowHalfOpen`, read back TRUTHFULLY from WS_ALLOW_HALF_OPEN
   * (duplex.new/transform.new/passthrough.new's own construction stores
   * whatever the program actually passed — WS_ALLOW_HALF_OPEN's own
   * header). The BEHAVIOR the flag governs stays unwired (named gap,
   * unchanged) — this is read-back fidelity only. */
  allowHalfOpenOf(): number {
    return this.cached("allowHalfOpenOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.ws.allowHalfOpen");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), WS_ALLOW_HALF_OPEN);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /** `(root) -> i32` — the top-level `.readable` getter (Node's real
   * shape: alive, not destroyed/errored, and not yet end-emitted). */
  readableAliveOf(): number {
    return this.cached("readableAliveOf", () => {
      const root = this.deps.rootRef();
      const idx = this.mb.declareFunc(this.mb.funcType([root], [I32]), "%w.rs.readableAlive");
      const c = new Code();
      const ROOT = 0, ST = 1;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.stateT(), RS_DESTROYED);
      c.i32Eqz();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_ERROR);
      c.refIsNull();
      c.i32And();
      c.localGet(ST);
      c.structGet(this.stateT(), RS_END_EMITTED);
      c.i32Eqz();
      c.i32And();
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  /* ── underscore-assign setters (stream.setRead/setWrite/setFinal/...) ── */

  setReadCore(): number {
    return this.cached("setReadCore", () => {
      const root = this.deps.rootRef();
      const readThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.readThunkSig() };
      const idx = this.mb.declareFunc(this.mb.funcType([root, EQ_REF, readThunkRef], []), "%w.rs.setRead");
      const c = new Code();
      const ROOT = 0, CLOS = 1, THUNK = 2, ST = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(CLOS);
      c.structSet(this.stateT(), RS_READ_CLOS);
      c.localGet(ST);
      c.localGet(THUNK);
      c.structSet(this.stateT(), RS_READ_THUNK);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  setWriteCore(): number {
    return this.cached("setWriteCore", () => {
      const root = this.deps.rootRef();
      const writeThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.writeThunkSig() };
      const idx = this.mb.declareFunc(this.mb.funcType([root, EQ_REF, writeThunkRef], []), "%w.ws.setWrite");
      const c = new Code();
      const ROOT = 0, CLOS = 1, THUNK = 2, ST = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(CLOS);
      c.structSet(this.stateT(), WS_WRITE_CLOS);
      c.localGet(ST);
      c.localGet(THUNK);
      c.structSet(this.stateT(), WS_WRITE_THUNK);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }

  setFinalCore(): number {
    return this.cached("setFinalCore", () => {
      const root = this.deps.rootRef();
      const finalThunkRef: ValType = { kind: "ref", nullable: true, typeIndex: this.finalThunkSig() };
      const idx = this.mb.declareFunc(this.mb.funcType([root, EQ_REF, finalThunkRef], []), "%w.ws.setFinal");
      const c = new Code();
      const ROOT = 0, CLOS = 1, THUNK = 2, ST = 3;
      c.localGet(ROOT);
      c.call(this.stateEnsure());
      c.localSet(ST);
      c.localGet(ST);
      c.localGet(CLOS);
      c.structSet(this.stateT(), WS_FINAL_CLOS);
      c.localGet(ST);
      c.localGet(THUNK);
      c.structSet(this.stateT(), WS_FINAL_THUNK);
      this.mb.setBody(idx, [this.stateRef()], c.bytes());
      return idx;
    });
  }
}
