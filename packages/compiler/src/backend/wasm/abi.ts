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
 * INC-26 pass P1 (design-host-v7.txt cccf7d6e §2.1-§2.5, DECISIONS.md D2/D3):
 * the process host contract adds `hostStr`/`hostNum`/`exit`, each
 * conditionally minted, each carrying this file's own three-tier
 * enforcement doctrine PLUS A FOURTH TIER this file has not needed before
 * (rev-26 R-14): two of these imports perform an EFFECT rather than
 * answering a value, and none of the three tiers below says anything about
 * whether the effect happened. For every effect in this ABI the honest
 * answer is "NOTHING ENFORCES IT; the harness's own rows are the check",
 * and each entry below says so in those words rather than asserting the
 * obligation and moving on — §2.7's capability paragraph (below, D4/D6) is
 * the model this borrows: it names the enforcement instead of asserting
 * the duty.
 *
 *   (import "tsinter" "hostStr" (func (param i32 i32 i32 i32) (result i32)))
 *     hostStr(kind, index, ptr, cap) -> len. Writes at most `cap` UTF-16
 *     CODE UNITS (2 bytes each, little-endian) starting at `ptr` in the
 *     exported memory, and answers the datum's TRUE length in code units.
 *     Three answers, and only three: len <= cap means the datum was
 *     written and its length is len; len > cap means NOTHING was written —
 *     retry with a buffer of at least len; len === -1 means NO SUCH DATUM
 *     (an argv/env index past the end), distinct from an EMPTY datum
 *     (len 0). The retry contract exists so the module can start with a
 *     modest stack buffer and pay a second call only on long values.
 *     WHY UTF-16 AND NOT UTF-8: the tier stores UTF-16 (S002, `(array
 *     i16)`) and the host's strings are JS strings, which ARE UTF-16 —
 *     code units move with no transcoder on either side. THE HOST MAY SEND
 *     ANY UTF-16 SEQUENCE INCLUDING UNPAIRED SURROGATES, and the module
 *     stores whatever it is given: the tier's storage is faithful (S002)
 *     and its OWN write boundary already replaces a lone surrogate with
 *     U+FFFD on the way OUT, so a host that sends one produces exactly
 *     what Node would print — the module never re-validates on the way in.
 *     `cap` and `len` are CODE UNITS; the exported memory is BYTES. Getting
 *     that factor of two wrong at a call site is a silent truncation on
 *     odd-length data — it is a call-site concern, not this import's.
 *     KIND TABLE (module and host must agree; the numbers ARE the ABI: no
 *     gaps, no reuse, append-only — later passes consume kinds this pass
 *     does not mint, but the table below ships whole and once):
 *       0  argv[index]                      6  versions.node
 *       1  env key   at index                7  versions.openssl
 *       2  env value at index                8  os.tmpdir
 *       3  cwd                               9  os.homedir
 *       4  platform                         10  os.type
 *       5  arch                             11  os.release
 *      12  execPath                         13  os.userInfo.username
 *      14  os.userInfo.homedir              15  os.userInfo.shell
 *      16  os.networkInterfaces AS A JSON DOCUMENT
 *      17  the host's own text for errno `index` — the one consumer of the
 *          UNKNOWN arm in the fs errno enumeration (a later pass), and the
 *          one place `index` means something other than an ordinal.
 *     `index` is ignored for every kind but 0, 1, 2 and 17. This pass
 *     (P1) mints and consumes kinds 0-4 only; 5-17 are later passes' — see
 *     `hostNum`'s identical stance below for the reason both tables ship
 *     complete now rather than growing a gap at a time.
 *     hostStr's EFFECT TIER: that the host WROTE the bytes it claims to
 *     have written is enforced by NOTHING. A host that answers a length
 *     and writes nothing hands the module a run of NUL code units and no
 *     error anywhere — the harness's own rows are the check.
 *
 *   (import "tsinter" "hostNum" (func (param i32 i32) (result f64)))
 *     hostNum(kind, arg) -> f64 — every NUMBER-valued host fact.
 *       0  argc                              1  env pair count
 *       2  pid                               3  uid
 *       4  gid                               5  isTTY(fd = arg): 1 or 0
 *       6  columns(fd = arg): -1 = no width  7  uptime, in SECONDS
 *       8  cpuUsage.user, microseconds       9  cpuUsage.system
 *      10  threadCpuUsage.user              11  threadCpuUsage.system
 *      12  availableMemory, bytes           13  constrainedMemory, bytes
 *      14  rusage field `arg`, 0..15        15  os.totalmem, bytes
 *     Kinds 0 and 1 are read ONCE each, at the argv/env snapshot (below);
 *     everything else is read at its own call site, every time. This pass
 *     mints and consumes kinds 0-1 only; 2-15 are later passes' (same
 *     append-only stance as `hostStr`).
 *     Inherits the WEAK f64 result-kind case (§ the `now`/`wallClock`
 *     precedent above): a numeric-string host is indistinguishable from a
 *     correct one. THE VALUE ITSELF is enforced by nothing — a host
 *     reporting a zeroed rusage or a negative uptime runs silently; the
 *     text is the only guarantee (the `wallClock` shape, restated).
 *
 *   (import "tsinter" "exit" (func (param i32)))   [process.exit modules only]
 *     The host TERMINATES THE INSTANCE with this status. IT MUST NOT
 *     RETURN. The module emits a defensive `unreachable` immediately after
 *     the call — this both keeps the wasm stack types honest and turns a
 *     broken host into a loud trap rather than a program that runs on past
 *     its own exit. The host implements this by THROWING A SENTINEL it
 *     recognises: a JS exception thrown from a `tsinter` import unwinds
 *     through nested wasm frames with its identity intact — its own class,
 *     its own `.code`, and NOT a WebAssembly.RuntimeError — and nothing in
 *     the module after the call runs, identically from `_start` and from
 *     inside a timer callback under `_tick`. That is Node's "nothing after
 *     process.exit runs" with no in-module unwind machinery and no cost
 *     that grows with stack depth.
 *     THE PROPERTY THIS RESTS ON IS THE TIER'S, NOT THE ENGINE'S: a host
 *     throw is not INHERENTLY uncatchable inside wasm — the same throwing
 *     import IS catchable by a `try_table`/`catch_all` in a module that has
 *     one. It escapes THIS tier's modules only because THE TIER EMITS NO
 *     EXCEPTION-HANDLING OPCODES AT ALL: try/catch/finally lower through a
 *     pending-flag unwind, never through wasm's own exception-handling
 *     proposal, so there is no handler for a host throw to be caught by.
 *     Node's `try { process.exit(0) } finally { ... }` does NOT run the
 *     finally, and this reproduces that for free ONLY because there is no
 *     wasm EH — a later increment that lowers `finally` to
 *     `try_table`/`catch_all` would silently start running the finally and
 *     swallowing the exit. The dependency is invisible unless it is written
 *     down, which is why it is written down here.
 *     exit's EFFECT TIER: that the host actually TERMINATES, and does not
 *     return, is enforced by NOTHING. The module's defensive `unreachable`
 *     after the call turns a returning host into a trap rather than into a
 *     program that runs past its own exit — that is the MODULE defending
 *     itself, not enforcement, and the harness's own rows are the check.
 *
 * THE ARGV/ENV SNAPSHOT (D2). `process.argv` and the whole of `process.env`
 * are read ONCE, at first touch, into module-owned storage — never a live
 * per-read fetch. argv: at first touch, the module reads argc (`hostNum`
 * kind 0) then argv[0..argc) (`hostStr` kind 0) into ONE interned
 * module-global `string[]`; every later `process.argv` read answers that
 * SAME array (Node's own process.argv is one interned mutable array, and
 * this is that model, not a simplification of it — a per-read fetch would
 * break any program that mutates argv and reads the mutation back). env:
 * at first touch of ANY env key, the module reads the pair count (`hostNum`
 * kind 1) then all pairs (`hostStr` kinds 1 and 2) into one in-module map;
 * get/set/unset/`in`/spread/Object.keys all run against that map from then
 * on. THE ONE OBSERVABLE THAT DISTINGUISHES A SNAPSHOT FROM A LIVE PROXY is
 * a spawned CHILD inheriting a variable this module wrote — no import in
 * this ABI can reach a child process, so nothing observable can tell the
 * difference yet; the first increment that gives this tier a child_process
 * surface must revisit this decision.
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
export const IMPORT_HOST_STR = "hostStr";
export const IMPORT_HOST_NUM = "hostNum";
export const IMPORT_EXIT = "exit";
export const EXPORT_ENTRY = "_start";
export const EXPORT_TICK = "_tick";
export const EXPORT_STATUS = "_status";
export const EXPORT_MEMORY = "memory";

export const FD_STDOUT = 1;
export const FD_STDERR = 2;

/* hostStr's KIND table (0..17) — see the import's own doc comment above.
 * Append-only: a later pass adds a new constant at the next integer, never
 * renumbers one of these. INC-26 P1 mints and consumes 0-4; 5-17 are later
 * passes', declared now so the table ships whole and once. */
export const HOST_STR_KIND_ARGV = 0;
export const HOST_STR_KIND_ENV_KEY = 1;
export const HOST_STR_KIND_ENV_VALUE = 2;
export const HOST_STR_KIND_CWD = 3;
export const HOST_STR_KIND_PLATFORM = 4;
export const HOST_STR_KIND_ARCH = 5;
export const HOST_STR_KIND_VERSIONS_NODE = 6;
export const HOST_STR_KIND_VERSIONS_OPENSSL = 7;
export const HOST_STR_KIND_OS_TMPDIR = 8;
export const HOST_STR_KIND_OS_HOMEDIR = 9;
export const HOST_STR_KIND_OS_TYPE = 10;
export const HOST_STR_KIND_OS_RELEASE = 11;
export const HOST_STR_KIND_EXEC_PATH = 12;
export const HOST_STR_KIND_OS_USERINFO_USERNAME = 13;
export const HOST_STR_KIND_OS_USERINFO_HOMEDIR = 14;
export const HOST_STR_KIND_OS_USERINFO_SHELL = 15;
export const HOST_STR_KIND_OS_NETWORK_INTERFACES_JSON = 16;
export const HOST_STR_KIND_ERRNO_TEXT = 17;

/* hostNum's KIND table (0..15) — same append-only stance. INC-26 P1 mints
 * and consumes 0-1; 2-15 are later passes'. */
export const HOST_NUM_KIND_ARGC = 0;
export const HOST_NUM_KIND_ENV_PAIR_COUNT = 1;
export const HOST_NUM_KIND_PID = 2;
export const HOST_NUM_KIND_UID = 3;
export const HOST_NUM_KIND_GID = 4;
export const HOST_NUM_KIND_IS_TTY = 5;
export const HOST_NUM_KIND_COLUMNS = 6;
export const HOST_NUM_KIND_UPTIME = 7;
export const HOST_NUM_KIND_CPU_USER = 8;
export const HOST_NUM_KIND_CPU_SYSTEM = 9;
export const HOST_NUM_KIND_THREAD_CPU_USER = 10;
export const HOST_NUM_KIND_THREAD_CPU_SYSTEM = 11;
export const HOST_NUM_KIND_AVAILABLE_MEMORY = 12;
export const HOST_NUM_KIND_CONSTRAINED_MEMORY = 13;
export const HOST_NUM_KIND_RUSAGE = 14;
export const HOST_NUM_KIND_OS_TOTALMEM = 15;
