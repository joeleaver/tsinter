# Library mode on the WasmGC lanes, for Playweft's game scripting: design

Status: a design for Joe's review, written 2026-11-11 against `d26a4899`. No
compiler code has changed. Nothing here is scoped in until Joe decides (§9).
Scope: the `wasm` lane, and the `wasm-native` lane where it matters. The legacy
`scriptc build --lib --profile` (C static archive, c/llvm lanes) retires at N4,
and this design reuses only its ideas and its diagnostic family.

Every claim is pointed at code, measured by a probe (§10), or marked **guess**.
The Playweft facts are the ones its spike session gave us. They are information,
not a commitment, and issues #166–#172 restate them.

---

## 0. Summary

**What Playweft needs.** One `.wasm` per game, the same bytes on wasmtime and in
the browser. The module exports fixed entry points (`pw_setup`, `pw_run`, the
`*_eval` evaluators), imports about 78 numeric host functions (modules `pw` and
`pwui`), and keeps its state between calls. Peers must stay bit-identical. It
also needs a deterministic runaway stop, the replicated random stream, and a way
to snapshot and restore the whole guest state for rewind, rollback and late join.

**The recommended approach**, in one paragraph. Add a **library build of the
WasmGC module**, driven by a **profile** (a JSON file the embedder ships, the
same idea as the legacy profile, with format 2 and `emission: "wasm"`). The
profile names the exports and the import modules, with a wasm class for each
parameter (`i32 u32 i64 u64 f32 f64 bool`, plus the pointer classes `string`,
`bytes`, `f32array`, `u32array` and `f64array`, each of which becomes a
`(ptr, len)` pair). The TS side writes ordinary `export function pw_run(sys:
number, tick: bigint, dt: number)` and an ambient `declare module "pw" {...}`.
The compiler checks each TS signature against its profile entry. The module's
import section is then **closed**: exactly the profile's imports that the program
reaches, and nothing else. Any other capability (a clock, entropy, the console
unless mapped, `node:*`, timers, the dynamic engine) refuses at compile time with
a named SC40xx diagnostic. Each export first runs module initialisation (only
inside the profile's init export), then the function body, then **drains
microtasks to quiescence**. An escaping exception, a fence or an exhausted budget
**poisons** the instance: it reports through a profile-named import and traps, and
every later call traps at once. Determinism has four in-module pieces: a
back-edge and call **budget counter**, a **call-depth counter** that gives the
same stack-overflow point on every engine, `Math.random` read from the **host
stream** (`rand_u64`), and refusing everything nondeterministic
(`Date.now`, `performance.now`, `WeakRef` and `FinalizationRegistry`, GC-timed
behaviour).

**The snapshot recommendation (#168): (a), a compiler-generated serializer**
over everything reachable from the module's globals. It writes deterministic
bytes, keeps object identity, stamps the build id, and restores into a fresh
instance. Two things make it practical in tsinter in particular. First, async
is already lowered to heap state machines, so a task suspended at `await
wait(s)` is ordinary heap data and there is no native stack to capture. Second,
the compiler knows every struct type it emitted. Its costs are an identity slot
in each shareable struct (WasmGC cannot hash a reference), a function id in each
closure (a `funcref` cannot be compared), roughly 1–1.5 units of work, and a
snapshot time of about 0.3–1 ms per 10k live objects (**guess**, which phase
P5's first step measures). Option (b), keeping authoritative state in host ECS
fields, goes with it as authoring *guidance* that keeps snapshots small, but not
as a rule. Option (d), compiling the module to a **linear-memory** wasm through
the existing wasm2c and mark-sweep path, is the serious alternative. Playweft's
memory-copy snapshots would then keep working unchanged, but it is a new lane
with a larger and slower module and clang in the hot-reload loop. I recommend
keeping it as the fallback if (a)'s measurement fails the tick budget.

**Phases** (a unit is about one of our usual units, design plus build plus one
review; sizes are **guesses**):

| phase | what | size |
|---|---|---|
| P0 | A library-mode harness: Node with a JS host shim is the oracle, and the same shim drives the wasm module on V8 and on wasmtime. Playweft sample games go in as corpus. | 0.5 |
| P1 | The module contract: profile v2, scalar exports and imports, init, drain per export, poison and trap, a closed import world, `rand_u64`, the depth counter | 1 |
| P2 | Linear-memory interop: the pointer classes, the scratch arena, `tsinter:memory`, an arity check | 0.5–1 |
| P3 | Game-code blockers: #170, #171, Map/Set values holding functions (found by probe, §7), and whatever the Playweft census shows | 1–2 |
| P4 | The runaway guard (#172) | 0.5–1 |
| P5 | Snapshot and restore (#168), option (a) | 1–1.5 |
| P6 | Compile time for hot reload: hot-spot fixes, then a warm compile server | 1 |

P1+P2 are the minimum before a game runs at all. With P3 the real games run.
P4 is required before untrusted code runs, and P5 before rewind and rollback.
P6 can run alongside any of them.

---

## 1. What exists today

- **One entry point.** The emitter exports `_start`, plus `_tick` or `_loop`
  for timer and event modules, `_status` for top-level await, and `memory`
  (`emitter.ts` `run()`, ~6062–6220; the names are in `abi.ts:1526–1530`).
  `export function` in the source is not exported (#167; the 170-byte module).
  A module with a `lib` field is refused outright: `if (this.mod.lib !==
  undefined) this.refuse("module:lib")` (emitter.ts:6062).
- **The memory is already there.** Every module exports a linear `memory`, which
  `write(fd, ptr, len)` uses as a staging area (abi.ts:958). The GC heap and the
  linear memory already sit side by side. Probe w2: the sample game validates,
  AOT-compiles, instantiates and runs on wasmtime 45 with `-W
  gc=y,function-references=y`, with the memory exported.
- **No wasm exception handling, tail calls or multi-memory.** Exceptions are
  pending-flag (a global kind plus checks), and a trap is `unreachable` after a
  report. Probe w3: the 1k-line sample validates with only the `mvp, gc,
  reference-types, function-references, bulk-memory, sign-extension,
  saturating-float-to-int, multi-value` feature set. Multi-memory appears only
  when the QuickJS island is embedded (S103), and library mode refuses that.
- **Imports are already minted only when reachable** (`now`, `seed`,
  `wallClock`, `hostStr`, ...: emitter.ts ~3230–3290, from per-capability
  prescans such as `mathRandomReachable`). The closed import world in §2.6 is
  the same mechanism with a deny list where today there is an import.
- **`Math.random`** is V8's xorshift128+, seeded once from `seed()` (S068,
  abi.ts:989).
- **Stack overflow is engine-dependent on the wasm lane.** It is whatever V8 or
  wasmtime traps at. Only wasm-native counts frames (`w_depth`, `W_DEPTH_MAX` =
  20,000; S117(b)). Two peers on different engines would therefore overflow at
  different depths. §4.3 fixes that.
- **The checkpoint machinery exists.** `emitFirstCheckpoint` and
  `emitCheckpointCore` (microtasks, nextTick, unhandled-rejection ledger) run at
  `_start`'s tail and in `%w.tick`. A library export reuses the checkpoint core
  at its own tail.
- **The legacy library mode** (`library/profile.ts`, `frontend/lib-exports.ts`,
  `frontend/lib-contract.ts`, `library/int-infer.ts`, `library/fence-eval.ts`,
  `library/wyhash.ts`) has a JSON profile (prefix, entry, export map with
  marshalling classes, init and reset symbols, determinism fences), the
  SC4001–SC4023 family, a "poisoned" guard after a trap, prove-or-refuse
  inference for i64/u64, and a wyhash64 `build_id` over the canonical module
  graph. Everything except the C emission carries over as design. The code
  carries over where it is lane-neutral: the profile loader, export resolution,
  int-infer, fence-eval and wyhash.

## 2. The module contract

### 2.1 Declaring the ABI: a profile, checked against TS

TS has one number type, so the wasm class of a `number` (i32? f32? f64?) has to
be written down somewhere. There are two choices:

- **(P) A profile.** The JSON names each export and import with its classes, and
  the TS signature must be *compatible*: `number` for f64/f32/i32/u32, `bigint`
  for i64/u64, `boolean` for bool, `string` for `string`, `Uint8Array` for
  `bytes`, `Float32Array` for `f32array`, and so on. This is the legacy design,
  and the profile is also where determinism policy lives (§5), so one file says
  what the module may touch.
- **(T) TS-only branded types.** For example `import type { i32, f32 } from
  "tsinter:abi"` and `export function pw_run(sys: i32, tick: i64, dt: f64)`.
  This reads well, but brands leak into the authors' stdlib types, and the
  profile still has to exist for the determinism and import-world policy.

**Recommendation: (P)**, with the profile generated by Playweft's own tooling
from its ABI table, which it already has (72+6 imports). Sketch:

```jsonc
{
  "profile_format": 2,
  "name": "playweft",
  "entry": "game/main.ts",
  "emission": "wasm",
  "init": "pw_setup",                      // runs module evaluation first (§2.3)
  "report": { "module": "pw", "name": "log_error" },  // poison report sink (§2.5)
  "max_import_params": 8,                  // wasm-bindgen's JS-closure cap (§3.4)
  "exports": [
    { "export": "pw_abi_version", "params": [], "returns": "u32" },
    { "export": "pw_setup", "params": [], "returns": "void" },
    { "export": "pw_run", "params": ["u32", "u64", "f64"], "returns": "void" },
    { "export": "pwdef_eval", "params": ["string"], "returns": "result:string" }
  ],
  "imports": {
    "pw": {
      "get_f32":     { "params": ["i64", "i32", "i32"], "returns": "f32" },
      "query_next":  { "params": ["i32"], "returns": "i64" },
      "emit_command":{ "params": ["string"], "returns": "void" },
      "rand_u64":    { "params": [], "returns": "i64", "role": "random" }
    }
  },
  "determinism": { "budget": { "source": "export", "name": "pw_set_budget" },
                   "max_depth": 10000 }
}
```

The export names are the wasm export names. A profile entry that names no
`export function` in the entry module is SC4002, as in legacy. A TS signature
incompatible with its classes is SC4003. A generic signature is SC4007.

**Overloads.** An `export function` with overload signatures exports its
implementation signature, which must match the profile. That is enough for the
boundary functions. Overloads inside the stdlib are plain TS and need #171 (§7).

### 2.2 Scalar class mapping at the boundary

The oracle is Node running the same TS with a JS host shim (§8.1). The rules are
therefore whatever keeps the wasm module equal to that.

| class | TS | inbound (host → TS) | outbound (TS → host) |
|---|---|---|---|
| f64 | number | exact | exact (NaN payloads: §4.4) |
| f32 | number | widen, exact | `Math.fround`, which is what a JS host would get from `new Float32Array([x])[0]` |
| i32 / u32 | number | exact | **checked**: must be integral and in range, else a fence that poisons (§2.5). Never a silent ToInt32 wrap. |
| i64 / u64 | bigint | `BigInt` exact | checked in range, else a fence |
| bool | boolean | i32, 0 is false and nonzero is true | 0 or 1 |
| void | void | – | – |

Choosing *checked* over *wrapping* makes a bug like passing `1.5` as a component
id loud instead of silently wrong. That is CLAUDE.md's rule one. The legacy
prove-or-refuse inference (`int-infer.ts`) can remove most of these checks at
compile time later. It is an optimisation, not a contract. Note that `bigint`
on the tick parameter makes every `tick` arithmetic a BigInt operation in the
module. Playweft's stdlib wrapper converts it once (`Number(tick)`), which is
exact below 2^53 ticks.

### 2.3 Imports from ambient declarations

The import module is an **ambient module named in the profile**:

```ts
// pw.d.ts, shipped by Playweft beside its stdlib
declare module "pw" {
  export function get_f32(e: bigint, comp: number, field: number): number;
  export function emit_command(cmd: string): void;
  export function rand_u64(): bigint;
}
// stdlib.ts
import * as pw from "pw";
```

The frontend resolves the specifier `"pw"` to the profile's import table. Every
function the program *reaches* becomes `(import "pw" "get_f32" (func (param i64
i32 i32) (result f32)))`, and the call site applies §2.2's conversions. Under
the Node oracle, a loader hook resolves `"pw"` to the JS shim, so the program
text is the same on both sides.

**Today's failure.** A global `declare const pw` compiles, then traps with "pw
is not defined" (#166). In library mode, every reachable ambient value that no
profile entry binds is a **compile-time refusal**: a new SC4024, "ambient
'pw' has no binding in the profile". Failing at the call would be
Node-faithful, but in an embedding it only moves a certain failure to a later
point. Outside library mode, nothing changes.

Not supported in v1: externref and host objects (Playweft uses i64 handles),
closures across the boundary, and import *results* in the pointer classes. The
host fills a guest buffer instead (§3.2).

### 2.4 Start, init and microtasks

- **No `_start` and no wasm start section.** A start function runs inside
  `WebAssembly.instantiate`, before the host has the instance or its memory, and
  a trap there has nothing to report through. Instead, the profile's `init`
  export (Playweft: `pw_setup`) first runs **module evaluation**: every
  module's top-level code in import order, exactly what `_start` does today,
  minus the exit tail. Then it runs the TS `pw_setup` body.
- **Order.** Every other export called before init, or init called twice, is a
  boundary fence: "pw_run called before pw_setup". It poisons.
- **Top-level await: refused in library mode** (SC4004 family). Evaluation must
  finish inside the init call. Async work starts from a function instead
  (`void spawner()`), which then lives across calls.
- **Drain at every export.** The body runs, then the checkpoint core runs
  microtasks and nextTicks to quiescence, then the unhandled-rejection check
  runs, and only then does the export return. This is Node's order for a
  macrotask: the host call *is* the macrotask. Promise continuations unblocked
  by this tick (for example, `wait` resolved by the stdlib's tick hook) finish
  inside this `pw_run`. Tasks still parked on an unresolved promise stay in the
  heap until a later call resolves them.
- **Async exports are refused** (SC4004, as in legacy). The ABI has no promise.
- **Timers** (`setTimeout`/`setInterval`/`setImmediate`) are refused: they need
  `now` and a host loop. Games use the tick-driven `wait`. **guess**: a later
  unit could map timers onto the tick, but nothing asks for it.

### 2.5 Errors and traps at the boundary

Three things can end an export abnormally: an exception that escapes the export
body or a microtask in its drain, a fence (S122: a tsinter limit or a failed
check), and an exhausted budget or depth limit (§4).

The proposed behaviour is the same for all three. Format the report as Node
would ("Uncaught TypeError: ..." or "tsinter: budget exhausted in pw_run"), pass
it to the profile's `report` import as `(code: i32, ptr, len)`, set the
**poisoned** global, and trap (`unreachable`). Every later export call,
including init, traps at once with code "poisoned". The legacy design had the
same guard. The module never continues after an unwound export: its heap may be
half-updated, and determinism across peers is gone if one peer continues
differently. The host's recovery is a restore from a snapshot (P5) or a reload.

If a game wants one failing system not to kill the run, that is a `try/catch`
in Playweft's TS dispatcher, which is ordinary code with Node's semantics. Fences
and budget stops cannot be caught (§4.2), which is S122's ruling: catchable only
where Node also throws.

Unhandled rejections behave as in Node by default: fatal, so they poison too.

### 2.6 The closed import world

In library mode the import section is exactly the profile imports the program
reaches, plus nothing else. Each `tsinter` capability gets its own refusal:

| capability today | library mode |
|---|---|
| `write` (console) | mapped if the profile names `console` → `(module, name)` with `(fd i32, ptr, len)`, else console calls refuse |
| `now`, `wallClock`, `tzCall` | refused: `Date.now`, `new Date()`, `performance.now`, timers (SC4008 family, determinism denial) |
| `seed` | replaced by the profile's `role: "random"` import (§5) |
| `hostStr`/`hostNum`/`exit`/`fs`/`net`/... | refused: no `process`, no `node:*` (SC4005 family) |
| `random` (crypto) | refused: `crypto.getRandomValues`, `randomUUID` |
| island engine (`__island_eval`, `--dynamic`) | refused (SC4006) |

`WeakRef`, `FinalizationRegistry`, and anything whose answer depends on GC
timing are refused too. On a single engine they are only "unspecified", but
across V8 and wasmtime they diverge.

## 3. Linear-memory interop

### 3.1 Memory layout

The module keeps one linear memory (`memory`, memory 0) next to the GC heap. Its
pages are:

- the existing **staging region** used by `write`;
- a **scratch arena**, a bump allocator that resets at the start of every export
  call. Outbound strings, byte payloads and arrays for an import call go here.
  They are valid until the import returns, and the host copies them
  synchronously, as with `write` today. Its default size is 64 KiB, it grows
  with `memory.grow` on demand, and it never shrinks;
- a **persistent heap** for buffers the TS program keeps (a `mem.alloc(n)`
  free-list allocator). Playweft's "guest-owned buffers" that the host reads
  after a call, the eval result buffers, live here.

Everything in linear memory is **guest-owned**. The host only reads and writes
inside ranges the guest passed it in the current call. The memory's contents are
deterministic, because no addresses leak from the GC heap. Probe w2 confirms an
exported memory works on wasmtime alongside GC.

### 3.2 The marshalling classes

| class | wasm params | TS type | semantics |
|---|---|---|---|
| `string` (import param) | `ptr i32, len i32` | string | UTF-8 encode into scratch. A lone surrogate becomes U+FFFD, which is `TextEncoder`'s rule, so the oracle shim does the same. |
| `bytes` (import param) | `ptr, len` | Uint8Array | copied into scratch |
| `f32array`/`f64array`/`u32array`/`i32array` | `ptr, len` (len in **elements**) | the typed array | copied, little-endian |
| `string` (export param) | `ptr, len` | string | the host wrote UTF-8 at ptr, in a buffer it obtained from the profile's `alloc` export. Decode with replacement. |
| `result:string` / `result:bytes` (export return) | – | string / Uint8Array | written to a persistent result buffer, then the module exports `<name>_result_ptr()` and `<name>_result_len()`, which is Playweft's existing shape. Valid until the next call of the same export. |

**Out-buffers** such as `phys_query(ptr, len, out ptr, cap) -> i32` and
`get_vec3(e, c, f, ptr)` use the low-level API instead of a class, because
they are stdlib plumbing, not author-facing.

```ts
import { mem } from "tsinter:memory";
const p = mem.scratch(24);            // i32 address, valid for this export call
pw.get_vec3(e, c, f, p);
return [mem.f64(p), mem.f64(p + 8), mem.f64(p + 16)];
```

`tsinter:memory` contains:

- `scratch(n)`, `alloc(n)` and `free(p)`;
- `u8/i32/u32/f32/f64(p)` reads and the matching `set*` writes, little-endian
  and bounds-checked: an out-of-range access is a fence;
- `utf8(p, len) → string`, `putUtf8(s) → len` (into scratch, with the pointer
  from `lastPtr()`);
- `copyF32(p, n) → Float32Array` and its siblings for the other typed arrays.

On the Node side, the oracle shim implements `tsinter:memory` over a JS
`ArrayBuffer`, so this API is testable against Node like everything else.

**Copies, not views.** tsinter's typed arrays are GC arrays, so a `Float32Array`
cannot alias linear memory. WasmGC has no bulk copy between a GC array and
linear memory, so a mesh crosses as an element loop: about 1 ns per element,
**guess**, or about 0.3 ms for 100k vertices × 3 floats. That is fine for meshes
built at load time. If per-tick bulk crossings show up, a zero-copy
`LinearF32Array` (pointer, length, get/set; not a real `Float32Array`) is a cheap
addition.

### 3.3 Inbound strings from the host

An import can't return a string. The host writes into a guest buffer with the
existing **`hostStr` retry pattern**: the guest passes `(ptr, cap)`, and the host
answers the true length. If the length is larger than `cap`, nothing was
written, and the guest retries with a buffer that is big enough. The stdlib
wraps this once.

### 3.4 wasm-bindgen's 8-argument cap

On the web, the host's imports are JS closures that wasm-bindgen generates with
at most 8 arguments. Each pointer class costs 2 wasm parameters. The compiler
counts the **expanded** wasm arity of every import and refuses with a new SC4025
("pw.register_system has 9 wasm parameters; this profile's limit is 8") when
it is over the profile's `max_import_params`. Playweft's biggest listed imports
(`phys_query` and `register_system`, 4 each) fit easily. Exports have no such
cap, since the host calls them through `instance.exports`.

## 4. Determinism inside the module

### 4.1 The runaway guard (#172)

**Where it counts.** One unit is charged at:

- every loop back-edge (`while`, `for`, `for-of`, `do`, and the generated loops
  of `for-in` and spread);
- every function entry, including closures, constructors, getters, and
  state-machine resumes, so an async task resumed by a drain is charged too.

Built-ins compiled into the module charge in proportion to their work: `sort`
per comparison, `JSON.parse` and `stringify` per 64 bytes, regex per
backtracking step, string building per 64 code units, array copies and spreads
per 64 elements. Most of these already contain loops that the back-edge rule
covers automatically, because they are compiled TS or emitted wasm. The
explicit charges are for the emitted runtime helpers that loop in raw wasm, so
"automatic" needs an audit list in P4.

**Why the count is deterministic.** It counts the module's own wasm control flow,
and the bytes are identical on every engine. No engine optimisation can change
how many times a back-edge executes. GC timing has no effect on the count.

**Code shape.** The counter is a mutable `i64` global, `$fuel`. Each check is
`global.get; i64.const k; i64.sub; global.tee; i64.const 0; i64.lt_s; if →
call $outOfFuel`. In loops whose body makes no call, the counter is cached in a
local and written back at exits and before calls (probe w4's "local" variant).
A straight-line run between checks can be batched into one charge of `k`. That
keeps the count exact, because no other check can happen in between.

**Control.** The host sets the budget per call. The recommended way is a profile
`budget.source`: either an export `pw_set_budget(n: u64)` that the host calls
before each export, or an import the module reads at every export entry. Unset
means unlimited.

**Running out.** It goes through §2.5's path with code "budget": report, poison,
trap. It is **not catchable**. A catchable stop is a sandbox escape, because
`while(true){ try { spin() } catch {} }` never stops. Every engine stops at the
same check, so two peers report the same system and tick.

**Cost, measured (probe w4).** On a worst-case tight f64 loop of 2×10⁸
iterations with no calls, V8 is +43% with the global counter and +22% with the
local-cached counter. With one call per iteration, the cost is within noise
(382 ms vs 381 ms). On wasmtime 45 the differences are inside the run's noise,
since the numbers include its compile time. Real game code is dominated by GC
loads, calls and host imports, so the expected cost is **2–8%** (**guess**). P4
measures it on Playweft's 94 systems. It is opt-in per profile, so a trusted
build pays nothing.

### 4.2 Not catchable, but reported precisely

The report names the export, the counter's remaining value, and (with the name
section kept) the function where the check fired. The latter needs no stack
walk: the check site passes its function index as a constant.

### 4.3 A deterministic stack depth

On the wasm lane, a stack overflow traps wherever the engine's native stack
ends, and V8 and wasmtime differ. Library mode adds wasm-native's rule (S117(b))
inside the module: a depth global, incremented at each non-leaf function entry
and decremented at exit. Past the profile's `max_depth`, it reports `RangeError:
Maximum call stack size exceeded` through the poison path. The limit must sit
below both engines' real limits for the stack sizes Playweft configures (V8's
default, and wasmtime's `max_wasm_stack`). P1 measures the two and picks a
default of about 10,000 (**guess**), which goes in an S-entry. Its cost is two
global updates per call, which shares the fuel check's code size.

### 4.4 Floats

Arithmetic is IEEE-exact on both engines. The one spec-level freedom is **NaN
payload and sign bits** produced by arithmetic. A program can observe them only
by writing a NaN into a typed array or DataView and reading the bytes back, and
the snapshot writer (§6) could also expose them. The proposal: the snapshot
writer canonicalises NaNs, and a typed-array store of a NaN canonicalises in
library mode (one compare on f32/f64 stores into byte-addressable storage). This
is registered as an S-entry. wasmtime's `cranelift_nan_canonicalization` setting
would do it host-side, but V8 has no equivalent, so it has to be in-module.

## 5. Randomness, clocks, entropy

- **`Math.random` reads the replicated stream (#169).** In library mode,
  `Math.random()` calls the profile's `role: "random"` import (`rand_u64() ->
  i64`) on every draw and maps it as `Number(u >> 11n) * 2⁻⁵³`, done in i64 in
  the module, which is exact on every lane. No generator state stays in the
  module, so the snapshot has nothing to capture, and the replay draws the same
  numbers because the host replays its stream. The oracle shim installs the same
  `Math.random` over the same stream. This is an S-entry alongside S068: the
  sequence is the host's.
- **The cost of an import per draw.** It is one host call, about 5–20 ns,
  **guess**. Draw-heavy code (particles) could ask for a profile mode that seeds
  an in-module xorshift from the stream once per export call instead. That
  generator state is then rebuilt at each call, so it needs no snapshot. This is
  not proposed for v1.
- **Clocks: refused by name** (§2.6). Game time is the `tick` and `dt`
  parameters. If authors need a clock, the profile can map `Date.now` to an
  import that the host replicates. This is a deliberate, registered choice, not
  a default.
- **Entropy: refused.** `crypto.*` randomness, `randomUUID`.
- **Locale and ICU.** `toFixed`, `toLocaleString`, collation and case mapping
  are compiled into the module from tables (numfmt, collation, casing). They are
  deterministic already, and no host is asked.

## 6. State snapshot and restore (#168)

The problem: Playweft rewinds by copying the guest's whole linear memory. A
WasmGC module's state lives in the engine's GC heap, which the host can neither
see nor copy. That state is module `let`s, closures and their boxes, class
instances, Maps and Sets in insertion order, the microtask queue, and async tasks
suspended at `await`.

### 6.1 The options

**(a) A compiler-generated serializer and deserializer.** Exports
`pw_snapshot() → result:bytes` and `pw_restore(bytes)`. The writer walks
everything reachable from the module's **mutable globals**, in global index
order, field by field in declaration order, and writes a compact
tag/ordinal/field stream. The output starts with the build id (wyhash64 over the
module bytes) and a format version, and `restore` refuses a snapshot from a
different build.

What tsinter already gives:

- *Suspended tasks are heap data.* Async functions and generators are lowered
  to state-machine structs (`statemachine.ts`, `promises.ts`), with no native
  stack and no continuation. A task parked at `await wait(0.5)` is a frame
  struct referenced from a promise's reaction list, so the walker captures it
  like any object.
- *Every type is known.* The emitter built every struct and array type, knows
  its fields' mutability and subtyping, and knows the env subtype per closure
  function (`envTypeFor`, emitter.ts:7641). The serializer is generated per
  module from the types actually used, so a typed-only game pays only for its
  own types.
- *A determinism model already exists.* Addresses are never observable, so a
  walk in a fixed order gives the same bytes on V8 and wasmtime.

What WasmGC makes hard, and the fixes:

1. **No reference hashing.** A walk that preserves identity (two references to
   one Map come back as one Map) needs a visited table, and WasmGC cannot hash
   or order a reference. The fix is a hidden mutable `i32` **ordinal slot** in
   every struct type that can be shared: classes, records, closures' boxes,
   Maps, promises and frames. During a snapshot, the first visit assigns
   ordinal+1 and appends the object to a visit list. Later visits write a
   back-reference. At the end, the list resets every slot to 0. The cost is 4
   bytes per object (often absorbed by alignment, **guess**) and one `i32.const
   0` per `struct.new`. Strings are immutable and their identity is not
   observable in JS, so they serialize by value, optionally deduplicated.
2. **`funcref` is not comparable.** A closure's code field can't be turned into
   an id. The fix is to add an immutable `i32` **function id** to the base
   closure struct (`$clos`, emitter.ts:6434). The deserializer rebuilds the
   closure with `ref.func` from a generated `br_table` keyed by id. Zero-capture
   closures are interned per function, so they restore as the interned global
   and keep `f === f`.
3. **Immutable fields force an allocation order.** A struct with an immutable
   reference field must be built after its target. Cycles can only run through
   *mutable* fields, since WasmGC cannot build an immutable cycle. So the
   reader builds objects in reverse topological order over immutable edges,
   then patches the mutable edges. Both orders are static per type graph.
4. **Runtime caches in globals.** Examples are the one-char string cache, regex
   programs and template-string interns. Rule: every mutable global is
   serialized, except globals marked as caches *whose identity is unobservable*.
   Those are reset to null and rebuilt lazily. Template-object identity is
   observable (`tag\`\`` caches), so template interns are serialized.
5. **The linear memory is the host's to copy.** The persistent buffers of §3.1
   live there, so the snapshot covers the GC heap, and the host keeps copying
   the memory as it does today. The two together are the whole guest state. The
   scratch arena is dead between calls and needs no copy.
6. **NaNs are canonicalised** on write (§4.4), so snapshot bytes from two
   engines compare equal. This also gives Playweft a **desync check** for free:
   compare snapshot hashes between peers.

What goes in the format, limits included: the `rand_u64` mode has no state to
store; host handles are plain i64 numbers; there are no externrefs; refused
features (WeakRef, timers) can't be in the heap. Nothing reachable is ever
unserializable, so there is no "skipped value" case to name.

Costs:

- **Work:** 1–1.5 units (**guess**). Breakdown: the type-graph analysis and
  generated walkers, the ordinal and function-id fields (which touch closure and
  struct emission broadly), the global classification, the format and its
  versioning, and corpus rows that snapshot mid-program, restore into a fresh
  instance, and check the run matches an uninterrupted one on both engines.
- **Size:** the generated walkers grow with the number of types used, about
  5–15 KB per game, **guess**. They are emitted only when the profile asks for
  snapshots.
- **Time:** a type-switch walk at about 30–100 ns per object gives 0.3–1 ms per
  10k live objects, **guess**. Restore costs about the same plus allocation.
  P5's first step measures this on Playweft's largest game before the rest is
  built.
- **A side benefit:** restoring into a fresh instance compacts the heap, which
  mitigates wasmtime's cycle-leaking collector (§9.3, risk R2).

**(b) Keep authoritative state in linear memory and host ECS.** Entity fields
already live host-side, and if GC state were only "rebuildable" (caches, derived
tables), a rollback would need nothing from the guest. The cost is in authoring.
Module `let`s, a `Map` of per-entity script state, closures registered per
system and tasks suspended at `await wait(s)` are exactly the state Playweft
says games keep. They would all have to become host fields or explicit
records, and no compiler can enforce "rebuildable", so a mistake is a silent
desync. That breaks rule one. As a *rule* this is a severe restriction (#168
says so). As *guidance* ("keep bulk per-entity data in ECS components"), it
makes (a)'s snapshots small and fast. **Use it as guidance with (a).**

**(c) Deterministic re-execution from a checkpoint plus inputs.** Restore means
a fresh instance, `pw_setup`, then re-running every tick from the checkpoint
with the recorded inputs and host state. The only guest-side requirement is the
determinism this design already provides. The cost is replay time: with no
in-guest checkpoint, the checkpoint is tick 0. That makes late join and long
rewinds O(game length), and a rollback of n ticks costs n × the tick time after
restoring the host's memory. It is not a substitute for (a), but a complement:
with (a) taken every K ticks, the host replays at most K−1 ticks. That lets
Playweft trade snapshot frequency against replay cost, for example a snapshot
every 4th tick for rollback. The host side needs no compiler work.

**(d) Compile to linear memory instead.** The wasm-native lane already
translates the module to C (`backend/wasm2c.ts`) with a non-moving mark-sweep
collector (`wn_gc.c`). Compiling that C with clang for wasm32, with a host shim
in place of `wn_host.c`, gives a module whose **entire heap is linear memory**.
Playweft's memory-copy snapshot then works unchanged, and the module doesn't
need WasmGC at all. That would remove the Safari and wasmtime GC risks (§9.3).
The costs:

- the collector scans the C stack conservatively (wn_gc.c's header), which
  doesn't work in wasm32, where locals aren't in memory. It would have to
  collect only at export boundaries (empty stack) or get a shadow stack;
- its 64 GB virtual arena needs a wasm32 rework;
- the module is larger: translated code plus collector plus libc pieces, 2–4×
  by **guess**;
- it is slower: a software GC and indirect calls in place of the engine's GC,
  **guess** 1.5–3× slower than WasmGC, which may still beat QuickJS;
- clang joins the build, adding seconds to every hot reload (§7);
- it is a third lane to keep identical, with its own differential rows.

Its snapshot is whole-memory (several MB) rather than compact, but it is a
memcpy, which is Playweft's status quo.

**Other ideas considered.** Dirty-tracked incremental snapshots: write barriers
on every mutable field, a large speed and complexity cost, and no proof that
it's needed yet. Forked instances: no engine offers cloning a WasmGC store.

### 6.2 Recommendation

Choose **(a)**, with (b) as guidance and (c) as Playweft's host-side policy.
(a) is the only option that keeps the authoring model Playweft described (state
anywhere, tasks suspended across ticks), is exact by construction, gives
byte-identical snapshots on both engines, and stays on the lane we're investing
in. Its risk is speed. P5 starts with a measurement: a hand-generated walker
over the largest Playweft game's heap at its peak tick. If a snapshot doesn't
fit in roughly 1 ms per tick of budget at the snapshot frequency Playweft needs,
we stop and bring Joe (d), with the numbers.

**Hot reload and snapshots.** A new build has new types, and a restore refuses a
snapshot from another build. So hot reload keeps working as Playweft does it
today: the new instance runs `pw_setup` against host-held ECS state. Carrying GC
state *across builds* would need a schema-evolution story. That is out of scope
and left unpicked.

## 7. Compile time for hot reload

**Measurements (probes w1, w5),** in-process `compile()` on the laptop, one
run, no cache:

| program | first compile | warm compile | wasm size (gzip) |
|---|---|---|---|
| 53-line game sample | 0.83 s | 0.36–0.52 s | 55 KB (27 KB) |
| 1,061 lines (20 renamed copies) | 5.5–7.3 s | 2.7–4.4 s | 273 KB (60 KB) |
| 3,181 lines (60 copies) | 15.1 s | 8.9–11.2 s | 743 KB |

Cost is about linear, roughly 3 ms per source line warm, and Playweft's 2.4–4.5
s per game sits in the 1k-line row. The 1k-line profile, over three compiles of
11.6 s CPU:

- **lowering, 65% inclusive (7.5 s).** Within it:
  - **waiting on the tsgo checker** over the synchronous RPC channel
    (`requestBytesSync`), 2.7 s (23% of everything). The lowering asks the
    checker per node;
  - **`mapType`/`mapTypeOf`**, 3.2 s inclusive. Type mapping is recomputed per
    use;
- **emission, 28% (3.3 s).** About 0.45 s of each compile is
  `reachableFunctionNames`, and most of the rest is the **~27 separate
  whole-IR prescans** (each a reflective `scan` over every node, emitter.ts
  ~627–1200, one per capability, such as `mathRandomReachable`);
- **process and module start**, about 0.3–0.5 s on a cold process: ESM
  loading, the tsgo spawn and its lib load. A CLI invocation pays this on every
  build.

**Options, cheapest first:**

1. **Hot-spot fixes in the pipeline** (0.5 unit; this helps every user, not
   only Playweft):
   - memoise `mapType` per checker type id;
   - batch the checker queries per function (one RPC with every node's type)
     instead of per node;
   - fuse the 27 prescans into one IR walk that sets all the flags;
   - make reachability one pass with a name index.

   Expected 2–3× (**guess**), which would put a 1k-line game at about 1–1.5 s.
2. **A warm compile server** (`tsinter serve` or a watch mode; 0.5 unit). It
   keeps the process, the loaded compiler and the tsgo session alive. tsgo
   re-checks only changed files, which removes the cold 0.3–1 s and most
   checker time for untouched files.
3. **A cached stdlib and per-module lowering.** Playweft's typed stdlib is the
   same in every game, so its lowered IR could be cached by content hash plus
   its dependencies' type hashes. Only the game's own modules would lower again.
   The emitter still runs whole-program (reachability, type section, runtime
   helpers). This is larger (about 1 unit), and the lowering has cross-module
   facts (classes, prescans) that need care. Do it only if 1 and 2 don't reach
   the target.
4. **A lighter pipeline for edit-time builds,** for example skipping the
   peephole passes and keeping the name section. **guess**: a small win, since
   the measured time isn't in late passes.

**Recommendation:** 1, then 2. The target is under 1 s for a typical game edit
in the server. Bit-identical output stays a requirement: the server must produce
the same bytes as a cold build, and a P6 row checks that.

## 8. Testing contract, dependencies and blockers

### 8.1 The oracle for library mode

Node is still the oracle. A **JS host shim** implements the `pw` and `pwui`
imports over plain JS state: a fake ECS, a scripted `rand_u64` stream, a command
log. A driver calls the exports in a scripted sequence (setup, n × run, eval,
snapshot, restore). It runs three ways, and the outputs (the shim's command log,
every eval result, the report sink) must match byte for byte:

- Node runs the TS directly, with `"pw"` resolved to the shim by a loader hook;
- V8 instantiates the module with the same shim as imports;
- wasmtime runs the module with a Rust or C port of the shim. The port is
  small, the shim's logic is the corpus, and wasm-native's C host is the
  precedent.

This is a new harness file, tracked with the other gates. Its rows are the
Playweft sample games plus focused programs for each section above.

### 8.2 What it builds on

- **The checkpoint core** (§2.4) and the per-capability import minting (§1).
- **U1/U2's one dynamic world** is not needed. Game code must type-check, and
  library mode refuses the dynamic engine. `unknown`/`any` in typed stdlib code
  still lowers as today (jsval, native), which is fine.
- **The legacy library code** to lift and make lane-neutral before N4 deletes
  the C side: `library/profile.ts` (adding format 2), `frontend/lib-exports.ts`,
  `library/fence-eval.ts`, `library/wyhash.ts`, `library/int-infer.ts` (later,
  for check elision), and the SC4001–SC4023 texts. Its C-specific parts (archive,
  symbols, the sidecar) are not needed. Playweft hasn't asked for a sidecar, and
  the build id goes in the snapshot header instead.

### 8.3 Language gaps that block game code

| gap | status | what it blocks |
|---|---|---|
| **#170** iterable classes: generator `[Symbol.iterator]`, `Iterator<T>` returns, destructuring in a `for-of` header over a user iterable | open, refusal gap | `for (const o of objects)` and `for (const [coin, player] of contacts)`, the core shape of Playweft's system API |
| **#171** narrowing class-instance unions (`instanceof`, literal discriminant field) | open, refusal gap | the overloaded `get(f: Field)` / `get(f: Vec3Field)` API shape |
| **Map/Set values holding functions** (SC2009: "'(dt: number) => void' values have no Map slot yet") | **found by probe w1; no issue yet** | a `Map<number, System>` closure registry, the natural form of "dispatch to closures by integer id". Arrays of closures work today, which is what the probe used. |
| `export function` and ambient imports | #166, #167 | everything; this design is the fix |

Playweft's list of needs (classes, closures, tuples, Map/Set, discriminated
unions over records, overloads, async/await, `toFixed`, Math) is covered today,
apart from the three rows above, as far as the sample shows. Phase P3 runs the
real games' census through the harness to find the rest. Those gaps stay
ordinary refusal-gap issues fixed on the main lane, not library-mode work.

## 9. Plan, decisions and risks

### 9.1 Phases

| | contents | depends on | size |
|---|---|---|---|
| **P0** | §8.1's harness (Node, V8, wasmtime); Playweft sample games as corpus rows that refuse loudly today; probes for wasmtime 47's stack limit and GC collector | – | 0.5 |
| **P1** | Profile v2 (`emission: "wasm"`) and its loader; scalar exports and imports (§2.1–2.3); init and module evaluation; drain per export; poison and report; the closed import world (§2.6); `rand_u64` (§5); the depth counter (§4.3); S-entries for each divergence; SC4024–SC40xx | P0 | 1 |
| **P2** | Pointer classes, the scratch arena and persistent heap, `tsinter:memory` and its Node shim, the result-buffer exports, the arity check (§3) | P1 | 0.5–1 |
| **P3** | #170, #171, Map/Set function values, and the rest of the Playweft census | P0 (can run in parallel with P1/P2) | 1–2 |
| **P4** | The budget counter (§4.1), built-in charging audit, perf on 94 systems | P1 | 0.5–1 |
| **P5** | Snapshot and restore (§6, option a): measure first, then build | P1, P2 | 1–1.5 |
| **P6** | Compile-time hot spots, then the warm server (§7) | – | 1 |

When it is done, Playweft can ship one module per game that runs on both
engines, matches Node through the shim, stops runaway scripts at the same point
on every peer, and rewinds without the QuickJS guest.

### 9.2 Decisions for Joe

1. **Is this scoped in, and where does it go?** On 2026-11-10 you put the top-10
   projects first. This is about 6–8 units in total. My recommendation: P0–P2
   next, as one stretch (it unblocks Playweft running at all). P3's gaps
   (#170, #171) help general TS code too, so they can go into the regular
   queue. P4–P6 after the next top-10 re-measure.
2. **How the ABI types are written.** A profile file that Playweft generates,
   with TS checked against it (recommended), or brand types in TS
   (`i32`, `f32`). The profile also carries the determinism settings, so the
   file exists either way.
3. **What happens when a script fails at the boundary.** Recommended: the
   instance stops for good (report, then trap), and the host restores or
   reloads. A game that wants to keep running past a failing system catches the
   error in its own TS dispatcher. The alternative, where the module swallows
   errors and continues, risks peers drifting apart silently.
4. **Out-of-budget behaviour.** Recommended: a stop that scripts cannot catch,
   since catching it would let a script run forever. It is opt-in per profile,
   so trusted builds pay nothing. Expected cost when on: about 2–8%, with
   20–40% on the worst tight loops.
5. **The snapshot approach.** Recommended: (a), the compiler writes a
   serializer for the whole GC heap. It costs about 1–1.5 units, and its speed
   is measured before the rest of it is built. The alternative, (d), compiles
   games to old-style linear memory so Playweft's memory-copy snapshots keep
   working, but gives a bigger, slower module, a third lane and clang in the
   edit loop. A rule that games keep no state between calls is not recommended.
6. **Clocks and randomness.** Recommended: `Math.random` comes from the host
   stream, and `Date.now`, `performance.now` and timers are refused by name. The
   alternative is a host-replicated clock import that the profile can opt into.
7. **How to make edit-time compiles faster.** Recommended: first speed up the
   existing pipeline, which helps every user and is about a 2–3× guess. Then a
   warm compile server. Only then caching the stdlib.
8. **Bigint for 64-bit values.** Recommended: `i64`/`u64` parameters are TS
   `bigint`, exact. The alternative is `number` with a range check, which is
   simpler for authors but fails above 2⁵³. Playweft's entity handles are i64.
   If they use the high bits, this must be `bigint`.

### 9.2a Joe's rulings (2026-11-12)

1. **Yes:** P0–P2 next as one stretch; #170/#171 go to the general queue; P4–P6 after the next top-10 re-measure.
2. **Plain TypeScript.** Scripts are standard TS against an engine-generated `.d.ts`. The profile is OPTIONAL, generated by Playweft (never hand-written, never seen by script authors), with a type vocabulary that maps one-to-one onto WIT. With no profile: `number` crosses as f64, `bigint` as i64. Joe dislikes script authors needing special domain knowledge; revisit if it creeps in.
3. **Yes:** a boundary failure stops the instance for good (report, then trap); the host restores or reloads.
4. **An optional compiled-in deterministic counter, off by default.** Playweft runs lockstep sessions mixing wasmtime (server, desktop) and V8 (browser) peers, and its current QuickJS guest already counts inside the guest, so a survivable, deterministic stop needs the counter in the module. When off, the host uses wasmtime fuel or epochs.
5. **Option (a), a whole-GC-heap serializer, measured first.** Playweft scripts keep module-level state, closures and caches that must rewind (DESIGN.md "REALIZED DIFFERENTLY (2026-10-23, the rewind slice)"). The bar: today's linear-memory snapshot is ~0.05 ms save / ~1 ms restore native, ~0.3 / ~1.5 ms in Chromium, for ~2.7 MB.
6. **Yes:** `Math.random` comes from the host stream; Date/performance.now/timers are refused by name.
7. **Yes:** pipeline speedups first, then a warm compile server, then the stdlib cache.
8. **Yes:** i64/u64 are `bigint`.

### 9.2b The contract as built (P1, with the lead's rulings of 2026-11-12)

Where this differs from §2, this section wins.

- **Profile, format 2** (`library/wasm-profile.ts`): optional and
  engine-generated. Classes are WIT's: `bool s8 u8 s16 u16 s32 u32 s64 u64
  f32 f64 string list<u8|s32|u32|f32|f64>`; parameters are `[name, class]`
  pairs. Keys: `profile_format`, `emission`, `name`, `report` (`module`,
  `name`, `prefix`), `alloc`, `max_import_params`, `max_depth`, `exports`,
  `imports`. There is **no `init` key**. Without a profile: every
  non-generic `export function` of the entry is exported, every exact-name
  `declare module "x"` in the program's own .d.ts files is a host module,
  number is f64, bigint s64, boolean bool; the module also exports an empty
  `_initialize`.
- **Evaluation runs at the first export call**, whichever export it is:
  module evaluation, a drain, the body, a drain. Every later call: the body,
  a drain. This is Node's order (a module is evaluated before its exports can
  be called) and lets a host call `pw_abi_version()` first.
- **Constant exports** do not evaluate: an `export function` whose body is a
  single `return <expr>` where `<expr>` is a literal (a number, a negated
  number, a string, true/false) or an identifier bound to a module-level
  `const` with such a literal initializer, followed through imports
  (`return ABI_VERSION` with `export const ABI_VERSION = 47`). Syntax only:
  `return n as 5` or a call is an ordinary export. It answers its constant
  on any instance, fresh or stopped; a constant that does not fit its
  integer class refuses at compile time (S143). The build's contract
  (`<module>.lib.json` beside the module, and `CompileResult.library`)
  marks them `"constant": true`.
- **P5 note (restore):** restoring a snapshot marks the module evaluated and
  never re-runs top levels. Playweft's rewind instantiates a fresh module,
  calls `pw_abi_version`, restores, and does not call `pw_setup`.
- **Failures** (S140): text in the error buffer (`tsinter_error_ptr`,
  `tsinter_error_len`, readable after the trap), then the report import with
  `prefix + text` and no trailing newline (Playweft: `"E Uncaught TypeError:
  msg"`), codes 1 uncaught or unhandled rejection, 2 fence, 3 depth, 4 a
  call after the stop. Code 5 (init order) is retired with the first-call
  rule.
- **Depth** (S142): `max_depth` defaults to 2,000 (§10 w6), and the contract
  **requires wasmtime `max_wasm_stack` ≥ 1 MiB** of every host.
- **NaN** (S146): every NaN whose bits are observable (the boundary, typed
  array / DataView / Buffer float stores, tsinter:memory) is canonical.
- **Node's modules** (`node:*`, `crypto`, ...) refuse at the import (SC4026);
  `queueMicrotask` refuses by its own name for now.
- **Random** (S141): Playweft's mapping, `(x >>> 11) × 2^-53`.
- **Closed import world** (SC4026): a clock, `performance.now`, timers, the
  console (unless the program puts its own `console` on globalThis, P1b),
  process, `node:*`, crypto randomness, the local time zone, top-level
  await, the dynamic engine. `Math.random` needs a role:"random" import.
- **Globals (P1b):** `globalThis` lowers to one dynamic object holding the
  program's own writes plus the modelled builtins; an ambient `declare
  function` / `declare const` reads its name from it at the use site (absent:
  Node's ReferenceError), and a program write (`G.console = …`) wins over a
  builtin. Reading any other Node global through it stops by name (S145).
- **Tasks across ticks:** no synchronous-drain intrinsic. Playweft's bridge
  exports a `pw_task_step()` the host calls per woken task; each step's
  continuation runs in that export's drain (Node-checkable).
- **wasm-native:** library mode builds for `--backend wasm` only; other
  backends refuse by name.
- **Linear memory (P2):** `[0, 256)` the report prefix area, `[256, 4352)`
  the error buffer, then the persistent heap (8-byte headers, a first-fit
  free list), then the scratch arena (the output stage), whose base moves up
  as the heap grows. Growing the heap while the call's scratch is in use is
  a fence (`mem.alloc` after `mem.scratch` in one call needs a free block).
- **Pointer classes (P2):** an import's `string`/`list<…>` argument is
  staged in the scratch arena and the cursor is restored after the import
  returns, so a loop of calls does not grow memory. An export's pointer
  argument is written by the host into a buffer from the **alloc export**
  (the profile's `alloc`, default `tsinter_alloc`; it hands out scratch
  between calls) and copied before the body runs. A pointer result goes to
  a per-export persistent buffer, read with `<export>_result_ptr()` /
  `<export>_result_len()` (length in bytes for a string, elements for a
  list), valid until that export is called again. Lists: `list<u8>`
  (Uint8Array), `list<s32>` (Int32Array), `list<u32>` (Uint32Array),
  `list<f32>` (Float32Array); `list<f64>` refuses (no Float64Array in the
  tier yet).
- **tsinter:memory (P2):** the program types it (`declare module
  "tsinter:memory" { export const mem: {...} }`, the bridge's
  tsinter-memory.d.ts); tsinter recognizes `mem.<fn>(...)` by name: scratch,
  alloc, free, u8, i32, u32, f32, f64, setU8, setI32, setU32, setF32,
  setF64, utf8, copyU8, copyI32, copyU32, copyF32. Little-endian, byte
  addresses, bounds-checked (outside memory: a fence); a value that does not
  fit a setter's width is a fence (S143).
- **Arity (P2):** `max_import_params` counts wasm parameters (a pointer class
  is two), SC4025.

### 9.3 Risks

- **R1, Safari WasmGC.** Safari has shipped WasmGC since 18.2 (Dec 2024; verify
  on current iOS). Probe w3 shows the modules need no wasm exceptions, tail
  calls or multi-memory, which narrows the risk to WasmGC itself. Not yet
  measured: Safari's GC throughput and iOS memory limits. P0 should run the
  harness's V8 row in Safari (WebKit) once, as a smoke test.
- **R2, wasmtime's GC.** Its current documentation says the deferred
  reference-counting collector **"cannot currently collect cycles; they will
  leak until the GC heap's store is dropped"**, and that the copying collector
  is not yet functional (docs.wasmtime.dev, `Collector`, read 2026-11-11).
  Closures capturing themselves, parent/child objects and promise reaction
  chains are cycles. A long session on desktop could grow without bound.
  Mitigations: P5's restore into a fresh store compacts the heap; Playweft
  watches heap size and recycles the instance at a tick boundary through
  snapshot and restore; and wasmtime's copying collector when it lands. P0
  measures growth on the sample games over 100k ticks. Speed: Playweft measured
  4–10× faster than QuickJS on both engines, and that is the baseline to keep.
- **R3, size.** Measured: 55 KB raw / 27 KB gzip for the small sample, and
  13.6 KB per extra 53 lines. Playweft's 51–70 KB is in range. Library mode
  removes `_start`'s process surface, and the fuel and depth counters add about
  2–4% (**guess**). The snapshot walkers add about 5–15 KB when on. Stripping
  the `name` section (3 KB of the 55 KB) is a host-side choice. Watch the data
  segment (19 KB of the 55 KB: numeric and ICU tables). The tables are already
  pulled in only on reach, but `toFixed` brings formatting tables.
- **R4, determinism holes we haven't thought of.** The closed import world plus
  the oracle harness running *two engines* is the main defence: any engine
  divergence shows up as a V8/wasmtime mismatch row. Also, snapshot-hash
  comparison between peers (§6.1 item 6) turns a silent desync in the field
  into a detected one.
- **R5, the compile-time target.** The 2–3× is a guess from one profile. If the
  pipeline fixes fall short, the server (option 2) is still needed for the hot
  reload Playweft wants.

## 10. Probes (throwaway, not committed)

All probes ran on the laptop inside `systemd-run --user --scope -p
MemoryMax=16G -p MemorySwapMax=0`, with `compile()` from this worktree's
`dist` built at `d26a4899`.

- **w1:** a 53-line game sample (classes, Map of entities, closures registered
  as systems, a discriminated union, an async spawner awaiting a tick-driven
  `wait`, `toFixed`). With `Map<number, (dt) => void>` it refuses SC2009; with
  an array of closures it compiles to 55 KB, importing only `tsinter.write`.
- **w2:** that module validates, AOT-compiles (0.12 s) and runs `_start` and
  `_status` on wasmtime 45 with `-W gc=y,function-references=y,exceptions=y`
  and a no-op `write` preload. Exported memory and GC coexist.
- **w3:** `wasm-tools validate` with only `mvp, gc, reference-types,
  function-references, bulk-memory, sign-extension, saturating-float-to-int,
  multi-value, mutable-global` accepts both the 55 KB and the 273 KB modules.
- **w4:** a hand-written wat microbenchmark of budget-counter shapes (§4.1),
  2×10⁸ iterations, best of 3 on V8 (Node 24.18.1). Plain loop 258 ms, global
  counter 370 ms, local-cached 316 ms. Call per iteration: 382 vs 381 ms.
- **w5:** compile time at 53, 1,061 and 3,181 lines (renamed copies of w1), and
  a `--cpu-prof` of the 1,061-line compile aggregated by source area (§7).
- **w6 (P0, 2026-11-12):** the stack limit, wasm lane, tsinter-compiled
  recursion, binary-searched maximum depth. A small frame (one parameter, no
  allocation): V8 (Node 24.18.1, default stack) 12,550, wasmtime 47 (default
  `max_wasm_stack`, 512 KiB) 16,334. A heavier frame (four parameters including
  an object and a closure call, locals, an array): V8 4,478; wasmtime 3,273 at
  512 KiB, 6,541 at 1 MiB, 13,080 at 2 MiB (about 160 bytes a frame). Ruling
  (lead, 2026-11-12): `max_depth` defaults to 2,000, below the weakest column
  with margin; the profile may raise it, which needs wasmtime `max_wasm_stack`
  of at least 1 MiB (S142).
- **w7 (P0, 2026-11-12):** wasmtime 47's collectors on cyclic garbage (a
  `_start` program making 2,000,000 two-object cycles, wasmtime 47.0.0 CLI,
  `-C collector=…`): the copying collector (47's default; the C API cannot
  choose another) peaks at 28 MB RSS in 0.45 s; DRC at 656 MB in 1.8 s,
  because it cannot collect cycles (R2). Hosts on wasmtime 47 should keep the
  copying collector.
- **w8 (P0/P1, 2026-11-12):** heap growth over ticks, the forest sample
  (`tests/library-wasm/game-forest`) under the harness's wasmtime 47 C host
  (default config): max RSS 33.6 MB at 1,000 ticks, 34.7 MB at 10,000,
  37.5 MB at 100,000. The coin sample (`game-coin`: closures, Maps,
  promises and a task across ticks, ~700,000 export calls): max RSS 57.2 MB
  at 1,000 ticks, 57.6 MB at 10,000, 54.0 MB at 100,000 under wasmtime 47;
  on V8 the JS heap after a full GC stays at 4.4–4.5 MB and linear memory
  at one page throughout. No growth: the copying collector keeps up, and the
  scratch arena does not creep. (A first measurement showed growth; it was
  the harness host leaking query cursors, fixed in host.mjs/host.c.)
