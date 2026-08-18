/* process.nextTick's own FIFO — scr_async.c's ScrNtick (scr_next_tick,
 * scr_next_tick_raw) ported, and the SECOND queue the checkpoint now
 * juggles beside promises.ts's microtask FIFO. Emitted lazily, like every
 * other helper family here: a module that never calls `process.nextTick`
 * (and that no internal caller ever feeds a raw marker into — see below)
 * gets none of this.
 *
 * THE CHECKPOINT ORDER (measured against Node — SEMANTICS.md territory;
 * this file only supplies the queue, emitter.ts's emitCheckpointCore owns
 * the interleave). Node's lib/internal/process/task_queues.js
 * `processTicksAndRejections` is, at the C++ boundary, exactly:
 *
 *   do {
 *     while (tick queue not empty) run one;       // exhaustive: a tick
 *                                                  // enqueuing another
 *                                                  // tick is swept up by
 *                                                  // this SAME loop
 *     runMicrotasks();                            // V8-native, ALSO
 *                                                  // exhaustive — drains
 *                                                  // to empty INCLUDING
 *                                                  // jobs added mid-drain,
 *                                                  // without ever
 *                                                  // returning to the JS
 *                                                  // loop above
 *   } while (either queue non-empty);
 *
 * which is scr_loop_run's shape exactly: tick-queue-to-exhaustion, THEN
 * microtask-queue-to-exhaustion, repeat while either has new work. Four
 * measured probes (truth table below; oracle = real Node, node v24.18.1,
 * `--experimental-transform-types`) confirm this holds at every checkpoint
 * EXCEPT the very first one:
 *
 *   (a) inside an async fn, after an `await`: a nextTick and a `.then()`
 *       registered in the SAME synchronous stretch resolve MICROTASK
 *       FIRST — PROVIDED that resumption is still the program's first
 *       checkpoint (nothing else was pending before it; chaining a
 *       SECOND, THIRD, ... `await null` measures the identical result —
 *       consecutive microtask resumptions never exit the drain they
 *       started in, so more awaits alone never reach a later checkpoint).
 *       Mechanism: resuming from an `await` is itself a promise-reaction
 *       microtask running INSIDE an already-active `runMicrotasks()`
 *       call; anything newly `.then()`'d joins that SAME native drain (V8
 *       never yields back to the tick-queue-checking JS loop mid-drain),
 *       while a newly-queued nextTick waits in the JS-level queue until
 *       `runMicrotasks()` fully returns.
 *   (b) the FIRST checkpoint, straight synchronous top-level, ESM entry
 *       (`.ts`/`.js` under this repo's `"type":"module"`, `.mjs`): SAME
 *       result — microtask before tick — because the ESM loader awaits
 *       the module's own evaluation, so by the time our top-level body
 *       runs synchronously we are ALREADY nested inside the loader's own
 *       active microtask drain, exactly like (a). A plain CommonJS entry
 *       does NOT get this treatment (probes f/h: tick beats microtask at
 *       ITS first checkpoint, the textbook rule) — moot for this tier,
 *       since every module tsinter compiles is ESM-shaped (the promise/
 *       TLA runtime is already built on that model: module root, S012,
 *       `_status`).
 *   (c) cross-enqueue: a tick enqueuing a microtask and a microtask
 *       enqueuing a tick both resolve on the NEXT full pass of the OTHER
 *       queue, not immediately — the two-phase loop's fixpoint, exactly
 *       as scored by scr_loop_run's `continue`. Holds at the first
 *       checkpoint or later alike; measured at the first (probe c2 —
 *       awaits alone can't reach later, per (a) — a `setImmediate` gets
 *       the read-back far enough that the CURRENT drain has actually
 *       finished).
 *   (d) nextTick vs setTimeout(0) vs setImmediate: unaffected by any of
 *       the above — an ordinary macrotask boundary, timers.ts's existing
 *       (untouched) territory.
 *   (e) STEADY STATE, genuinely past the first checkpoint (a real
 *       macrotask boundary — timer/immediate callback, `_tick`'s own
 *       later calls): the textbook order holds PLAIN — ticks drain to
 *       exhaustion, then microtasks, no swap. Measured via 2310's own
 *       `setTimeout` callback registering both, wasm-nexttick.test.ts's
 *       matching pin, and directly against Node (probes f/h, a CommonJS
 *       entry's first checkpoint — the SAME plain order, just reached a
 *       different way).
 *
 * THE FIX: emitter.ts's checkpoint gets ONE extra, unpaired microtask
 * drain before the steady-state loop begins, but ONLY at the very first
 * checkpoint (`_start`, never `_tick`'s). Verified against the corpus
 * oracle byte-for-byte (2310, 2311) by hand-simulating this exact
 * construction before it was written — see the increment's report.
 *
 * A STALE COMMENT, NOT A DIVERGENCE. scr_stream.c's module header (~:42-
 * 47) claims stream ticks "drain after the fiber ready-queue" — the
 * OPPOSITE of what scr_loop_run (:1754-1783) actually does (ticks first,
 * to exhaustion, then microtasks) and the opposite of measured Node. The
 * C IMPLEMENTATION already matches Node; only that one comment is wrong.
 * Not a semantic divergence to register — a documentation bug for
 * whoever next touches scr_stream.c (stream stage A+), left as found.
 *
 * THE RAW-MARKER SEAM (stage B's entry point, unused here). C's ScrNtick
 * is `{ cb; raw; next }` — a real closure OR a bare C function pointer,
 * because scr_stream.c pushes one raw marker per deferred stream emission
 * onto this SAME queue so stream ticks interleave with user nextTicks in
 * true FIFO order (Node: they ARE nextTicks). `enqueueRaw` is that same
 * shape here — a bare `() -> ()` funcref, no closure, no captures — built
 * now so stage B has a queue to push onto; nothing in today's compiler
 * produces one (wasm-nexttick-raw.test.ts force-emits it directly against
 * ModuleBuilder, bypassing the frontend, the typedarrays.ts precedent). */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { ModuleBuilder, type ValType } from "./module.js";

/** What the runtime needs from the emitter that owns it. */
export interface NextTickDeps {
  /** The `() => void` closure pair every user nextTick callback arrives
   * as — the frontend adapts parameterized callbacks and trailing
   * arguments through its own wrappers before the libCall (lower-
   * calls.ts's `timerStyleCallback`), so this runtime only ever calls
   * zero-argument void closures. SHARED with timers.ts's identical dep:
   * `closPairFor([], [])` interns by signature, so both builders resolve
   * the same (struct, func) pair. */
  voidClos: () => { clos: number; fn: number };
  /** The exception cell's kind tag: nonzero after a callback means the
   * throw was UNCAUGHT and the program is over (SEMANTICS.md S007) —
   * timers.ts's identical dep. */
  excKind: () => number;
}

/* ntT's fields. Exactly one of CB/RAW is non-null per entry — the C
 * union's wasm translation (two nullable ref fields instead of a tagged
 * pointer, since WasmGC has no untyped union of two ref kinds). */
const NT_CB = 0;
const NT_RAW = 1;
const NT_NEXT = 2;

export class NextTickBuilder {
  private readonly fns = new Map<string, number>();
  private ntTField: number | null = null;
  private rawFnTField: number | null = null;
  private queue: { head: number; tail: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: NextTickDeps,
  ) {}

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  /** The stage-B seam's function type: a bare `() -> ()` funcref, called
   * with NO closure argument at all — scr_next_tick_raw's `void (*)(void)`
   * exactly. Public: a future producer (stream ticks) and the raw-marker
   * pin both need it to declare a matching function and take its
   * `ref.func`. Interned by signature (module.ts's `funcType`), so
   * repeat calls are free. */
  rawFnType(): number {
    this.rawFnTField ??= this.mb.funcType([], []);
    return this.rawFnTField;
  }

  private get ntT(): number {
    if (this.ntTField === null) {
      // Both field types are resolved BEFORE the entry is reserved:
      // selfStructType's `make` may not intern a type (module.ts).
      const cb: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const raw: ValType = { kind: "ref", nullable: true, typeIndex: this.rawFnType() };
      this.ntTField = this.mb.selfStructType("%w.nexttick.entry", (self) => [
        { storage: cb, mutable: false },
        { storage: raw, mutable: false },
        { storage: { kind: "ref", nullable: true, typeIndex: self }, mutable: true },
      ]);
    }
    return this.ntTField;
  }

  private ntRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.ntT };
  }

  private nullNode(c: Code): void {
    c.refNull(this.ntT);
  }

  private nullClos(c: Code): void {
    c.refNull(this.deps.voidClos().clos);
  }

  private nullRaw(c: Code): void {
    c.refNull(this.rawFnType());
  }

  /* ── the queue ─────────────────────────────────────────────────────── */

  /** The FIFO itself: one global pair, module-wide (there is exactly one
   * nextTick queue, like Node's). */
  private q(): { head: number; tail: number } {
    if (this.queue === null) {
      const t = this.ntRef();
      const init = (w: ByteWriter): void => {
        w.u8(0xd0); // ref.null $entry
        w.sleb(this.ntT);
      };
      this.queue = { head: this.mb.addGlobal(t, true, init), tail: this.mb.addGlobal(t, true, init) };
    }
    return this.queue;
  }

  /** The head global — exposed so the checkpoint's fixpoint loop (emitter.
   * ts) can test "is the queue non-empty" inline, exactly like the promise
   * runtime's root-promise check does for its own global. */
  headGlobal(): number {
    return this.q().head;
  }

  /** %w.nexttick.append(node) — FIFO tail-append, the append half every
   * entry kind (CB or RAW) shares. */
  private append(): number {
    return this.cached("append", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.ntRef()], []), "%w.nexttick.append");
      const q = this.q();
      const c = new Code();
      const N = 0;
      c.globalGet(q.tail);
      c.refIsNull();
      c.ifVoid();
      c.localGet(N);
      c.globalSet(q.head);
      c.else_();
      c.globalGet(q.tail);
      c.localGet(N);
      c.structSet(this.ntT, NT_NEXT);
      c.end();
      c.localGet(N);
      c.globalSet(q.tail);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.nexttick.enqueue(cb) — `process.nextTick(cb)`'s libCall target
   * (emitter.ts's emitTimerCall — the `cb` argument already carries any
   * trailing arguments and any parameter adaptation, lower-calls.ts's
   * `timerStyleCallback`, exactly like setImmediate's). */
  enqueue(): number {
    return this.cached("enqueue", () => {
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: this.deps.voidClos().clos };
      const idx = this.mb.declareFunc(this.mb.funcType([closRef], []), "%w.nexttick.enqueue");
      const append = this.append();
      const c = new Code();
      const CB = 0, N = 1;
      c.localGet(CB);
      this.nullRaw(c);
      this.nullNode(c);
      c.structNew(this.ntT);
      c.localSet(N);
      c.localGet(N);
      c.call(append);
      this.mb.setBody(idx, [this.ntRef()], c.bytes());
      return idx;
    });
  }

  /** %w.nexttick.enqueueRaw(fn) — the STAGE-B SEAM: an internal caller's
   * raw marker (scr_next_tick_raw's `void (*)(void)` twin — stage B's
   * stream ticks will push one dispatch marker per deferred emission).
   * No frontend libCall reaches this today; it is force-emitted and
   * exercised directly against ModuleBuilder (wasm-nexttick-raw.test.ts),
   * the typedarrays.ts validate-sweep precedent — a forced pin proving
   * the shape works, not dead code. */
  enqueueRaw(): number {
    return this.cached("enqueueRaw", () => {
      const rawRef: ValType = { kind: "ref", nullable: true, typeIndex: this.rawFnType() };
      const idx = this.mb.declareFunc(this.mb.funcType([rawRef], []), "%w.nexttick.enqueueRaw");
      const append = this.append();
      const c = new Code();
      const FN = 0, N = 1;
      this.nullClos(c);
      c.localGet(FN);
      this.nullNode(c);
      c.structNew(this.ntT);
      c.localSet(N);
      c.localGet(N);
      c.call(append);
      this.mb.setBody(idx, [this.ntRef()], c.bytes());
      return idx;
    });
  }

  /** %w.nexttick.drain() — run the queue to exhaustion (a tick enqueuing
   * another tick is swept up by this SAME loop, exactly like Node's own
   * `while (tock = queue.shift())`). Dispatch: CB non-null calls through
   * the uniform closure convention; CB null means a RAW marker, called
   * bare (no closure argument) through its own funcref — scr_next_tick_
   * raw's `raw()` exactly. An uncaught throw out of either ends the drain
   * immediately: the trap IS this tier's exit-1 channel (SEMANTICS.md
   * S007), the same contract timers.ts's callbacks already have. */
  drain(): number {
    return this.cached("drain", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], []), "%w.nexttick.drain");
      const pair = this.deps.voidClos();
      const q = this.q();
      const c = new Code();
      const N = 0, CB = 1;
      c.loop();
      c.globalGet(q.head);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.globalGet(q.head);
      c.localSet(N);
      c.localGet(N);
      c.structGet(this.ntT, NT_NEXT);
      c.globalSet(q.head);
      c.globalGet(q.head);
      c.refIsNull();
      c.ifVoid();
      this.nullNode(c);
      c.globalSet(q.tail);
      c.end();
      // Unlink before the call: the node is dead, and a live `next` would
      // keep the whole drained prefix reachable for the GC (promises.ts's
      // drain() rationale, verbatim).
      c.localGet(N);
      this.nullNode(c);
      c.structSet(this.ntT, NT_NEXT);
      c.localGet(N);
      c.structGet(this.ntT, NT_CB);
      c.localSet(CB);
      c.localGet(CB);
      c.refIsNull();
      c.ifVoid();
      // RAW marker: call the bare funcref, no closure argument.
      c.localGet(N);
      c.structGet(this.ntT, NT_RAW);
      c.callRef(this.rawFnType());
      c.else_();
      // User callback: arg0 is the closure itself (the uniform ABI).
      c.localGet(CB);
      c.localGet(CB);
      c.structGet(pair.clos, 0);
      c.callRef(pair.fn);
      c.end();
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.unreachable();
      c.end();
      c.br(0);
      c.end();
      const closRef: ValType = { kind: "ref", nullable: true, typeIndex: pair.clos };
      this.mb.setBody(idx, [this.ntRef(), closRef], c.bytes());
      return idx;
    });
  }
}
