/* The .wasm artifact's embedding contract — the ONE list a host has to
 * satisfy, shared by the emitter (which mints the names into the binary)
 * and every host that instantiates one (the differential harness today,
 * `tsinter run` and embedders tomorrow). A name change here is an ABI
 * break for every host, so nothing else may spell these strings.
 *
 * The surface is deliberately minimal and WASI-shaped without being WASI:
 * console output and a clock are the only capabilities the tier needs yet,
 * and the clock half appears ONLY in modules that can arm a timer.
 *
 *   (import "tsinter" "write" (func (param i32 i32 i32)))
 *     write(fd, ptr, len): the host writes len bytes at ptr from the
 *     exported memory to fd (1 = stdout, 2 = stderr), synchronously —
 *     the module reuses the staging region the moment the call returns.
 *
 *   (import "tsinter" "now" (func (result f64)))   [timer modules, and
 *                                                     perf.now modules]
 *     MONOTONIC milliseconds from an unspecified origin — the SAME clock
 *     `_tick`'s argument uses. Timers need a clock that never goes
 *     backwards, and this is that clock; `performance.now()` reads it too
 *     (widened, D3/P6 — the minting condition is now `timers.*` reachable
 *     OR `perf.now` reachable). NOT a wall clock: it says nothing about
 *     the date, and the difference between two readings is the only
 *     meaningful quantity — the origin is deliberately unspecified so a
 *     host may use whatever monotonic source it has (WASI 0.2's
 *     `monotonic-clock` is the same shape). The module reads it when it
 *     arms a timer or reads `performance.now()`, so every reader agrees
 *     on which clock this is.
 *
 *   (import "tsinter" "seed" (func (result i64)))   [Math.random modules only]
 *     ONE 64-bit value, read AT MOST ONCE per module instance, on the
 *     first `Math.random()` call. Present only in modules that reach
 *     `Math.random`. The module owns the generator: it seeds V8's
 *     xorshift128+ from this value (SEMANTICS.md S068) and every later
 *     draw is computed in-module, so the host is asked for entropy exactly
 *     once no matter how many numbers the program draws. THE HOST DECIDES
 *     WHAT RANDOMNESS MEANS HERE — a CSPRNG-backed host gets an
 *     unpredictable sequence, a fixed-value host gets a reproducible one
 *     (the `node --random-seed=N` contract). All 64 bits are used whole; a
 *     host returning a small nonnegative integer is legal.
 *     THIS IMPORT'S ENFORCEMENT SPLITS THREE WAYS, not the usual two —
 *     measured directly against the engine (WebAssembly.instantiate /
 *     WebAssembly.Module.imports):
 *       PRESENCE AND CALLABILITY — ENFORCED BY THE ENGINE, at
 *         instantiation, exactly like `write`/`now`: a missing or
 *         non-callable `seed` is a LinkError before a single instruction
 *         runs ("function import requires a callable").
 *       THE RESULT'S TYPE (an actual BigInt) — ALSO ENFORCED BY THE
 *         ENGINE, but LATER: not at instantiation (an i64-returning
 *         import is not type-checked against its declared signature until
 *         it is actually called), but at the FIRST DRAW. A host whose
 *         `seed` returns a `number` throws `TypeError: Cannot convert
 *         12345 to a BigInt` the moment `Math.random()` first calls it —
 *         `now`'s f64 result has no such backstop (§8.3's own text: a
 *         wrong-typed `now` runs to completion and prints different
 *         output with no error at all). This is the one place this ABI's
 *         usual two-tier split (engine-enforced shape vs. unenforced
 *         value) does not hold: `seed`'s KIND is engine-enforced, just not
 *         until first use, while `now`'s KIND is not enforced at all.
 *       THE VALUE ITSELF (origin, quality, range) — ENFORCED BY NOTHING,
 *         same as every other value contract in this file: a host may
 *         return whatever 64-bit pattern it likes, including one from a
 *         BigInt outside the signed i64 range some source produced by
 *         mistake — WebAssembly reduces any BigInt mod 2^64 silently (a
 *         measured example: 2**70n + 5n arrives in the module as 5n).
 *         Whether that pattern came from a CSPRNG or a predictable counter
 *         is the host's business, exactly as `now`'s origin is — the
 *         guarantee here is the same shape as `now`'s, but it covers only
 *         this VALUE tier, not the result-type tier above it.
 *
 *   (import "tsinter" "wallClock" (func (result f64)))   [Date.now / no-arg `new Date()` modules only]
 *     Milliseconds since the Unix epoch on the host's REAL-TIME clock, as
 *     an f64. Present only in modules that read `Date.now()` or construct
 *     a no-argument `new Date()`. MAY JUMP BACKWARDS: a real-time clock is
 *     subject to NTP steps, manual changes and daylight transitions, and
 *     nothing in the tier smooths that — a backwards step in the host is a
 *     backwards step in `Date.now()`, exactly Node. Code that needs
 *     elapsed time uses `now` below, never this.
 *     THE MODULE FLOORS TO INTEGER MILLISECONDS (a genuine floor, not a
 *     truncation — `-0.5` reads as `-1`, matching Node's own negative-time
 *     handling), so the observable granularity is the tier's and not the
 *     host's. A printed value from this clock cannot match any other
 *     process, so nothing in the differential compares one; the guarantee
 *     that this is the wall clock and not some other clock lives in THIS
 *     TEXT and in the host contract (D3, DECISIONS.md).
 *     ENFORCEMENT, measured directly against the engine (two independent
 *     hand-built-module runs agree — this pass's own CP1 §(g)/§3B-6 and
 *     rev-25's Phase A §7):
 *       PRESENCE AND CALLABILITY — ENFORCED BY THE ENGINE, at
 *         instantiation, before a single instruction runs — the SAME
 *         LinkError/TypeError shape `now`/`seed` already get:
 *         `LinkError: WebAssembly.instantiate(): Import #N "tsinter"
 *         "wallClock": function import requires a callable` (missing or
 *         non-callable) and `TypeError: WebAssembly.instantiate(): Import
 *         #N "tsinter": module is not an object or function` (namespace
 *         absent) or `TypeError: Imports argument must be present and must
 *         be an object` (the whole imports argument omitted). THE ENTRY
 *         POINT NAMES ITSELF IN THE TEXT — `WebAssembly.instantiate():`
 *         through the differential harness's own call shape, but
 *         `WebAssembly.Instance():` through `new WebAssembly.Instance`
 *         instead, for the identical failure — and "#N" is an INDEX that
 *         MOVES WITH THE MODULE'S OWN IMPORT LIST (this import is minted
 *         right after `seed`, C-1); quote either text as what it is, never
 *         as a fixed string with a hand-picked index.
 *       THE RESULT'S KIND — WEAKER than `seed`'s three-way split: a host
 *         returning a BigInt throws `TypeError: Cannot convert a BigInt
 *         value to a number` at the CALL (the one kind check an f64-typed
 *         import DOES get, at the WebAssembly JS-API boundary). EVERY
 *         OTHER JS value coerces SILENTLY via ordinary ToNumber: a numeric
 *         string ("1700000000000.75") produces OUTPUT IDENTICAL to a
 *         correct host — worse than "different output, no error", because
 *         on a numeric string there is no observable difference AT ALL;
 *         `null` -> 0; `undefined` / a non-numeric string / a valueOf-less
 *         object -> NaN; an object with `valueOf`/`toString` coerces
 *         through it, silently.
 *       THE VALUE ITSELF (origin, monotonicity, unit) — ENFORCED BY
 *         NOTHING: a backwards sequence is followed exactly, a host
 *         returning seconds instead of milliseconds runs silently, and
 *         `-Infinity` runs silently. The text IS the enforcement.
 *
 *   (export "_start" (func))            — the program; run it once.
 *   (export "_tick" (func (param f64) (result f64)))  [timer modules only]
 *   (export "_status" (func (result i32)))  [top-level-await modules only]
 *   (export "memory" (memory))          — where write's bytes live.
 *
 * THE EVENT LOOP. `_start` runs the program to its first checkpoint: the
 * synchronous body, the microtask drain, and the unhandled-rejection
 * report. If the module exports `_tick`, the host then PUMPS it — the
 * module has no clock of its own and cannot sleep, so the waiting is the
 * host's job:
 *
 *     let now = <clock>;
 *     for (;;) {
 *       const due = tick(now);
 *       if (due < 0) break;              // quiescent: the program is done
 *       now = Math.max(now, due);        // due === now ⇒ run again NOW
 *     }
 *
 * One `_tick(now)` call is one loop turn: drain microtasks, fire every
 * timer due at `now` (each followed by its own microtask drain), then run
 * the check phase (setImmediate). Its result is the next deadline — a
 * future time to wait for, `now` itself when ready work remains (pending
 * immediates), or a NEGATIVE value when nothing ref'd is left and the
 * program is over.
 *
 * A TRAP IS THE EXIT CODE — 1, always. A trap out of `_start` or `_tick`
 * is the program dying with exit 1: an uncaught exception, an unhandled
 * rejection, or a rejected top-level-await root (SEMANTICS.md S007, S010).
 * A normal return with a negative deadline is exit 0, UNLESS the module
 * exports `_status`:
 *
 *     let code = 0;
 *     try { start(); pump(); code = status?.() ?? 0; }
 *     catch (trap) { code = 1; }
 *
 * `_status()` exists ONLY in a module whose entry is an async module —
 * i.e. one using top-level await — and answers Node's status for the
 * module evaluation promise at QUIESCENCE: 13 when it is still pending
 * (Node's "unsettled top-level await" exit — SEMANTICS.md S012), 0 when
 * it settled. It is a pure read of that promise's state, so it is
 * only meaningful once the pump has returned a negative deadline; calling
 * it earlier answers about a program that is still running. A trap
 * overrides it: the program is already dead with exit 1, and a rejected
 * root traps rather than answering here.
 */

export const IMPORT_MODULE = "tsinter";
export const IMPORT_WRITE = "write";
export const IMPORT_NOW = "now";
export const IMPORT_SEED = "seed";
export const IMPORT_WALL_CLOCK = "wallClock";
export const EXPORT_ENTRY = "_start";
export const EXPORT_TICK = "_tick";
export const EXPORT_STATUS = "_status";
export const EXPORT_MEMORY = "memory";

export const FD_STDOUT = 1;
export const FD_STDERR = 2;
