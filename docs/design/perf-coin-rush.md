# Perf investigation: the Playweft Coin Rush gap

Status: investigation, 2026-11-11, against tsinter main `6bf9515c`. No compiler changes were
made. The benchmark is Playweft's spike harness (`tools/tsinter-spike/` on branch
`claude/tsinter-spike-6e72bb` @ `41515fe3`). It was only read; every variant below is a copy in a
scratch directory.

## Summary

1. **Most of the wasmtime column was the host, not the compiler.**
   - run.sh builds wtrun in debug.
   - wasmtime 47's default collector is the copying collector, not DRC. Its GC heap starts empty
     and grows only when a collection frees too little. A program with a small live set and a high
     allocation rate therefore keeps collecting a tiny heap.
   - A release wtrun with `Config::gc_heap_initial_size(8 MiB)` takes Coin Rush ×10 from 1,309 to
     631 µs per tick, and the shipped scene from 47 to 26 µs. Both are Playweft host settings.
2. **On V8 the gap is string keys, not tuples.**
   - tsinter on V8 is 1.2× behind Node on the shipped scene and 3.0× behind on ×10.
   - About 40% of the ×10 time goes to building `f.comp + "." + f.name` on every field access:
     removing that alone buys 40%. A similar share goes to hashing and comparing those keys char
     by char: `Map.get`, plus `kinds.indexOf` in `Obj.has` (37% by profile). GC is about 10%.
   - Fresh tuples and union boxes cost under 5%. A tuple allocation costs tsinter on V8 the same
     ~2 ns it costs Node.
3. **Code written C-like is already fast, and then the f64 shows.**
   - A rewrite of the stand-in engine (fields resolved to numeric slots once, kinds as a bitmask;
     coin.ts and the mains unchanged) runs on V8 at 3.8 µs (shipped) and 53 µs (×10). Node runs
     the same code at 4.4 and 17 µs.
   - In that code the main tsinter cost is that every number is an f64: `&` goes through an
     out-of-line ToInt32, and `for (let i…)` indexes arrays with an f64.
   - Emulating i32 lowering there takes ×10 from 53 to 32 µs on V8, and to 27 µs together with
     literal pooling and dropping the exception polls and null checks.
4. **Ranked tsinter work:**
   1. string-literal pooling;
   2. integer (i32) lowering;
   3. a cached string hash, or another way to avoid hashing a Map key on every lookup;
   4. inlining array callbacks (`filter`/`every`/`map` with an arrow literal);
   5. eliding union boxes.

   Scalar replacement of tuples comes last for this scene. For the game code as written, though,
   the biggest single win (5–8×) is engine API design: field handles that carry a resolved slot.
   That is Playweft's to make, not tsinter's.

## Setup

- **Timing machine:** nico-top, 16 CPUs, WSL. Load average 1.0–1.5 during every run, under
  the machine-wide heavy lock. The laptop ran at load 40–80 on 24 cores and was used only for
  profiles and allocation counts, which are proportions and counts rather than times.
- **Runs:** each cell is the median of 7 interleaved process runs (the table) or 5 (everything
  else). The min–max spread is under 5% unless noted.
- **Unit:** each scene prints its own µs per tick over 7,200 ticks, and its checksum. Every
  variant and every patched module printed the same checksum as Node.
- **Versions:** node v24.18.1 (V8 13.6), wasmtime crate 47.0.4, QuickJS through rquickjs 0.9 on
  the wasmtime 45 CLI, as run.sh builds it.
- **Runners:**
  - `run.mjs`, unchanged.
  - wtrun's source copied as `wt2`, plus environment knobs: collector, initial GC heap size,
    Cranelift inlining, and a GuestProfiler. Built `--release`, and also debug the way run.sh
    builds it (debug, dependencies at opt-level 2).
- **Name section:** tsinter already emits one (function names, `module.ts`), so V8 profiles and
  wasmtime guest profiles show `%%m0.Obj.vec`, `%w.strEq` and so on.

## 1. Re-measured

µs per tick (median). "wt" is tsinter on wasmtime.

| Scene | QuickJS | wt, debug (as run.sh) | wt, release | wt, release + 8 MiB initial GC heap | tsinter on V8 | Node JIT |
|---|---|---|---|---|---|---|
| Coin Rush as shipped | 174 | 47.5 | 34.2 | **26.1** | 11.8 | 9.6 |
| Coin Rush ×10 | 3,805 | 1,309 | 875 | **631** | 312 | 104 |
| Forest Ruin | 13.0 | 2.08 | 1.66 | 1.87 | 2.04 | 2.00 |

- This machine is 2.5–3× faster than the laptop the spike measured on, so the spike's absolute
  numbers don't carry over. The ratios do.
- **Release vs debug:** release alone is a 1.3–1.5× win on the Coin Rush scenes.
- **GC heap size** (wasmtime, base code; section 4 has the sweep):

  | Initial heap | Shipped | ×10 | Forest |
  |---|---|---|---|
  | default (empty) | 34.7 | 897 | **1.79** |
  | 8 MiB | **26.1** | 631 | 1.87 |
  | 64 MiB | 30.2 | **609** | 2.44 |
  | 256 MiB | 37.1 | 618 | 2.66 |

  8 MiB is the best single value: the large heaps hurt the small scenes.
- **Forest Ruin** is too small to separate the engines; the five tsinter and Node cells are within
  0.45 µs.
- **The wasm-native lane** (tsinter's own wasm → C → native, for reference): shipped 13.0, ×10
  300.6, Forest Ruin 1.29.

## 2. Where the time goes

### V8 profile

`node --cpu-prof` on ×10. In the normal profile, V8 inlines the small wasm helpers into their
callers: 55% self in `Obj.vec` and 17% in `World.began`, 12% in the garbage collector, and 70%
inclusive under `World.began`. To attribute that time, the profile was re-run with
`--no-wasm-inlining`, which adds call overhead but keeps the proportions:

| Cost | ×10, V8 | Shipped, V8 | ×10, wasmtime (guest profile, 256 MiB heap) |
|---|---|---|---|
| String hash + compare (`map.find`, `strEq`, `vec.indexOf`, `Obj.has`) | 37% | 22% | 48% |
| String building (`concat`, `str.flat`, `flatCat`, per-use literals) | 24% | 17% | 28% |
| Field accessors (`Obj.vec`/`num`/`get`: union box, tuple copy) | 17% | 13% | 5% |
| GC | 11% | 14% | (not visible, see below) |
| Engine loops (`began`, `runPhase`, `matched`, `move`) | 6% | 10% | 5% |
| Array callbacks + closures (`arr.every`, `arr.filter`, `%fn1`) | 3% | 14% | 13% |
| ToInt32 / f64-index helpers | 1% | 2% | 1% |

- **On the shipped scene on wasmtime**, the array-callback path is the largest single item: 40%
  of guest-profile samples are in `%arr.every.2`, `%arr.filter.*` and their closures. That is
  `World.matched`'s `this.objects.filter((o) => inc.every((k) => o.has(k)))`, which runs once
  per system per tick.
- **The guest profile** samples at epoch checks, which are function entries and loop headers.
  GC time therefore lands on whatever allocating function runs next (mostly `%w.concat`). With
  the Null collector the proportions barely move.

### Source constructs

The ladder in section 5 checks these causally.

| Source construct (pw.ts) | Runtime work per call | Calls per tick, ×10 |
|---|---|---|
| `this.vecs.get(f.comp + "." + f.name)` in `Obj.vec` / `num` / `setVec` | 1 literal `"."` materialized (`array.new_data`), 2 flat concats (alloc + `array.copy`), a ×31 polynomial hash over 18 UTF-16 units, `strEq` char loop, union box for `T \| undefined` | 2,530 |
| `[v[0], v[1], v[2]]` defensive copy in `Obj.vec` | 1 struct (`struct.new_default` + 3 `struct.set`) | 2,415 |
| `a.has(between[0])`, `b.has(between[1])` in `began`, and `inc.every((k) => o.has(k))` in `matched` | `kinds.indexOf(kind)`: `str.flat` type test, a loop of `strEq` (length check, then content) | 5,710 |
| `filter`/`every` callbacks in `matched` | closure + captured-variable cell allocated per object; one `call_ref` per element | 1,498 `call_ref` |
| Every call that may throw | `global.get $exc; if … return` poll afterwards | ~all calls |

- **No dynamic-value paths:** the modules contain no `$dyn` code and no island engine. The only
  union helpers are `%union.narrow` (95 calls per tick) and `%undef.fence`.

## 3. Allocations per tick

To count allocations, the WAT was instrumented: an i64 counter before every `struct.new*`,
`array.new*` and `call_ref`, plus one at every function entry. The counts below were read back
after `_start`. Rows are classified by the allocated type's shape.

| Kind | Shipped | ×10 | C-like ×10 |
|---|---|---|---|
| **Total** | **646** | **15,000** | **406** |
| String: concat result | 86 | 5,119 | 0 |
| String: literal materialized per use (`array.new_data`) | 79 | 2,770 | 101 |
| Union box (`number \| undefined`, `Vec3 \| undefined` from `Map.get`) | 52 | 2,658 | 80 |
| Tuple (Vec3) | 30 | 2,445 | 0 |
| Closures | 110 | 830 | 0 |
| Captured-variable cells, `{objects, contacts, events}`, `Objects`/`Began`/`Contacts`, `Side` | 157 | 876 | 50 |
| Array header + backing store (two allocations per array) | 97 | 113 | 73 |
| Iterator results `{value, done}` | 14 | 77 | 0 |
| `Math.cos`/`sin` scratch arrays (the ieee754 port allocates per call) | 8 | 80 | 80 |
| Map/Set storage | 11 | 12 | 1 |
| Tuple (Stick: main_coin's `[Math.cos(a), Math.sin(a)]`) | 2 | 20 | 20 |

- **Node allocates comparably.** `--trace-gc` shows 1,176 scavenges for Node on ×10 against
  1,593 for tsinter on V8. Node's JIT does not escape-analyse this code away, and its GC share is
  also high (19% of Node's own profile).
- **What differs** is how much work each allocation drags along. Node's strings cache their
  hash, and its literals are interned, so its `Map.get` with a fresh concatenated key costs 8 ns.
  tsinter's costs 84 ns (micro `concatKey`).

## 4. wasmtime collectors

µs per tick (median of 5; DRC on base code, 2 runs).

| | base, shipped | base, ×10 | C-like, shipped | C-like, ×10 |
|---|---|---|---|---|
| Auto = copying (wasmtime 47's default), empty initial heap | 33.5 | 877 | 5.35 | 209 |
| Copying, 256 MiB initial heap | 36.6 | 613 | 5.80 | 78.6 |
| Null (never collects) | 32.1 | 792 | 4.81 | 76.8 |
| DRC | 159 | 5,154 | 29.5 | 214 |

- **The default is copying, not DRC:** `Collector::Auto` resolves to `Copying` when the
  `gc-copying` feature is on, which it is by default.
- **DRC would be 3–8× slower** than copying with a sized heap (4.7× and 8.4× on the base code),
  so the spike's DRC hypothesis names the wrong collector. Its cost would be real if an embedder
  picked it.
- **Collection itself is cheap here.** With a heap big enough, copying runs at or below Null's
  cost: the live set is tiny, and Null's ever-growing heap pays in page faults.
- **What costs is the heap-growth policy.** It cost 30% of base ×10 time and 63% of C-like ×10
  time, and an initial heap size removes it. 8–64 MiB is the right range (section 1);
  256 MiB slows the small scenes.
- **Inlining:** `Config::compiler_inlining(Inlining::Yes)` changed nothing measurable (−4% to
  +2%).

GC vs compute on wasmtime ×10 (base code, release; heap-size sweep runs, so the default is 897
here against 875 in section 1):

| Share | µs | % |
|---|---|---|
| Heap-growth policy (default 897 against 64 MiB 609) | 288 | 32% |
| Everything else | 609 | 68% |

Within "everything else" the split follows the guest profile above: string work ~75%.

## 5. A/B: what each change buys

Two kinds of A/B, both on the same three scenes:

- **Source variants** (`pw.ts` copies; coin.ts, forest.ts and the mains unchanged):
  - `nocopy`: `began` and `lookAt` read the stored Vec3 instead of `vec()`'s fresh copy. This is
    exactly what scalar replacement, or a multi-value return of `vec()`, would give.
  - `key`: `Field`, `Vec3Field` and `Action` carry a prebuilt `key` string, so there is no
    concat per access.
  - `keynocopy`: both.
  - `clike`: numeric slots, `number[]` storage, a kind bitmask, numeric contact keys, plain
    loops, a reused iterator result.
  - `clike2`: clike with `for…of` in `began`/`matched` (tsinter lowers `for…of` with an i32
    index).
- **Emulated compiler optimizations:** a WAT rewrite of the module tsinter emitted, valid here
  because nothing throws. The checksums confirm it.
  - `lit`: every string literal becomes a module global built once (`array.new_fixed`), shared by
    content, instead of `array.new_data` at every use.
  - `noexc`: drops the pending-exception poll after calls.
  - `nonull`: drops the explicit null checks that throw a TypeError.
  - `i32mask`: inlines `i32.trunc_sat_f64_s` for ToInt32 in the mask-only functions.
  - `all` = lit + noexc + nonull (+ i32mask on the C-like rows).

µs per tick, medians. wasmtime with a 256 MiB initial heap.

| Variant | ×10 V8 | ×10 wasmtime | ×10 Node | shipped V8 | shipped wasmtime | shipped Node | Forest V8 | Forest wasmtime |
|---|---|---|---|---|---|---|---|---|
| base | 311 | 612 | 104 | 11.4 | 37.3 | 9.4 | 2.34 | 2.30 |
| base + lit | 242 | 572 | – | 9.6 | 33.4 | – | 1.64 | 1.98 |
| base + noexc | 308 | 611 | – | 11.2 | 36.9 | – | 2.07 | 2.30 |
| base + nonull | 306 | 604 | – | 11.6 | 35.8 | – | 1.90 | 2.32 |
| base + all | 233 | 573 | – | 9.1 | 33.8 | – | 1.62 | 2.02 |
| nocopy | 303 | 601 | 79 | 11.4 | 36.3 | 9.1 | 2.30 | 2.30 |
| key | 186 | 507 | 92 | 8.8 | 31.4 | 7.9 | 1.56 | 1.70 |
| keynocopy | 174 | 509 | 69 | 9.1 | 31.6 | 7.6 | 1.88 | 1.62 |
| keynocopy + all | 166 | 486 | – | 7.5 | 29.5 | – | 1.36 | 1.43 |
| clike | 52.6 | 77.7 | 17.2 | 3.8 | 5.8 | 4.4 | 0.83 | 0.57 |
| clike + i32mask | 47.9 | 62.9 | – | 3.6 | 5.3 | – | 0.80 | 0.57 |
| clike2 (i32 loop index) | 41.0 | 64.6 | 19.1 | 3.4 | 5.4 | 5.1 | 0.90 | 0.58 |
| clike2 + i32mask | 32.2 | 48.9 | – | 3.1 | 5.0 | – | 1.26 (noisy) | 0.58 |
| clike2 + i32mask + all | **27.5** | **44.2** | – | **2.7** | **4.3** | – | 0.85 | 0.55 |

The wasm-native lane on the same variants (×10 / shipped / Forest): base 301 / 13.0 / 1.29,
key 205 / 11.2 / 0.92, clike 45.0 / 4.0 / 0.46.

### Microbenchmarks

The same `micro.ts` was compiled with tsinter and run as JS under Node. Each row is ns per inner
operation, the best of 5 inside the process, and steady across 3 process runs.

| Kernel | tsinter V8 | tsinter wasmtime | wasm-native | Node |
|---|---|---|---|---|
| `mid(a, b)` returning a fresh Vec3 | 3.3 | 7.9 | 9.6 | 3.3 |
| the same arithmetic in locals | 1.1 | 2.8 | 1.0 | 0.8 |
| `Map<string,V3>.get(prebuilt 18-char key)` + defensive copy | 35.6 | 66.8 | 39.2 | 10.4 |
| `Map<string,V3>.get(prebuilt key)`, no copy | 33.0 | 62.8 | 30.2 | 4.5 |
| `Map<string,number>.get(comp + "." + name) ?? 0` | 83.9 | 97.0 | 70.4 | 8.2 |
| `Map<string,number>.get(prebuilt key) ?? 0` | 32.5 | 64.3 | 30.3 | 3.7 |
| `number[]` read by slot | 2.0 | 3.6 | 1.9 | 0.7 |
| `kinds.indexOf(kind) >= 0` (3 strings) | 17.7 | 32.3 | 9.1 | 4.2 |
| `(mask & bit) !== 0` | 9.0 | 11.2 | 5.8 | 0.8 |
| `xs.filter((x) => x > lim)`, per element | 5.5 | 22.4 | 6.6 | 2.3 |
| the same as a `for…of` + `push` loop | 2.7 | 6.2 | 3.1 | 2.4 |
| array sum, `for (let i…) s += arr[i]` | 1.8 | 3.5 | 1.7 | 0.7 |
| array sum, `for (const x of arr)` | 0.7 | 1.1 | 0.7 | 2.0 |
| `h = (h * 31 + (i & 255)) \| 0` | 15.2 | 12.2 | 5.5 | 3.8 |
| `Math.cos(x)` | 17.1 | 22.7 | 22.6 | 8.7 |

- **The costs, per item:**
  - A tuple allocation costs tsinter on V8 the same as Node: 2.2 ns against 2.5 ns.
  - A string-keyed lookup costs 8× Node, even with a prebuilt key: 33 ns against 4 ns.
  - Building the key per call adds 51 ns more.
  - An f64 loop index costs 2.8× an i32 one.
  - A bitmask test through ToInt32 costs 11× Node.
  - A callback through `call_ref` costs 2× a plain loop on V8 and 3.6× on wasmtime.

## 6. The hypotheses

| Hypothesis | Verdict |
|---|---|
| Every record, tuple and array is a separate GC allocation, and V8 escape-analyses tuples away | **True but minor.** 2,445 Vec3 tuples a tick on ×10, plus two allocations per array. Removing the tuple copies buys 2.6% on V8 and 1.8% on wasmtime. tsinter on V8 allocates a tuple as cheaply as Node does. Node's JIT doesn't remove these either (it gains 25% from `nocopy`). |
| String-keyed Map hashing, possibly rope flattening | **True: this is the gap.** Literal materialization, concat, the uncached ×31 hash and the char-by-char `strEq` take ~60% of ×10 time on V8 by profile (37% hash and compare, 24% building), plus the GC those allocations cause. Removing the per-access concat alone buys 40%. No ropes are involved: `Obj.*` uses `flatCat`. The 35,000 `str.flat` calls a tick are type tests, not flattenings. |
| Floats where ints would do | **True for C-like code, masked otherwise.** Emulated i32 lowering takes C-like ×10 from 53 to 32 µs on V8, and from 78 to 49 µs on wasmtime. On the shipped code it is under 1%. |
| Bounds and null checks | **Minor.** Dropping the throwing null checks: 0–2%. Dropping the exception polls: 0–8%. Bounds checks ride on the f64 index check (`vec.getU` truncates, converts back and compares) and go with i32 lowering. |
| `call_ref` through closures, no inlining | **True on wasmtime, moderate on V8.** 40% of the shipped scene's wasmtime samples are in the `filter`/`every` callback path. Per element it costs 3.6× a plain loop on wasmtime and 2× on V8. wasmtime's own inliner doesn't help. |
| Dynamic-value paths from loose typing | **Refuted.** No `$dyn` code is in either module. |
| wasmtime's deferred-refcounting collector | **Wrong collector.** wasmtime 47 defaults to copying. DRC would be 5–8× worse. The real cost is the copying collector's heap growth from an empty heap: 30–63% of ×10 time, fixed by an initial heap size in the host. |

## 7. Ranked tsinter optimizations

Each gain is measured on this benchmark (V8 / wasmtime). Sizes are rough: S is days, M is about
a week, L is weeks.

1. **String-literal pooling** (S).
   - **Change:** materialize each distinct literal once per module, as a global initialized at
     start or on first use, instead of `array.new_data` at every evaluation (`pushStrLitInto`,
     emitter.ts).
   - **Side effect:** equal literals then share a reference, so the `ref.eq` fast path in
     `strEq` hits for `kind === "f"` and `indexOf("score")`.
   - **Measured:** −22% on ×10 V8, −16% on the shipped scene, −30% on Forest Ruin. On wasmtime
     −7%, −10% and −14%.
   - **Risk:** strings are `(array (mut i16))`. Every in-place writer (`concat`, `str.flatten`,
     `f64ToStr`, `toFixed`) must only write arrays it just allocated. The ones in these modules
     do; the change needs that audit.
2. **Integer lowering** (L, with an S first step).
   - **Change:** i32 locals for integer-valued induction variables, bit-op results and array
     indices, with range or overflow analysis to keep Node's f64 semantics.
   - **First step:** an inline fast path for ToInt32 (`i32.trunc_sat_f64_s`, check, fall back).
   - **Measured (C-like):** −39% on ×10 V8 and −37% on wasmtime (the two halves stack, section
     5).
   - **Micro:** 2.8× on indexed loops, 11× on mask tests.
   - **Shipped code:** below 1%, because strings dominate.
3. **Not hashing a string key on every lookup** (M–L).
   - **Cause:** keys are flat i16 arrays with no hash slot. `map.find` hashes all of the key
     before it probes, and `strEq` then compares char by char.
   - **Options**, in rising cost:
     - a per-map last-key/last-slot memo keyed on `ref.eq`: hits whenever the caller reuses a
       key reference, as the `key` variant and pooled literals do;
     - a hash memo beside flat strings, for example the rope struct gaining a hash field, with
       flat keys wrapped on insert;
     - a flat string representation with a cached hash (L, touches every string path).
   - **Estimate:** a prebuilt-key `Map.get` costs 33 ns against Node's 4. On `keynocopy` ×10
     that is ~2,500 lookups × ~28 ns ≈ 70 µs of 174 (40%).
4. **Array-callback inlining** (M).
   - **Change:** lower `filter`/`every`/`some`/`map`/`forEach`/`find` called with an arrow
     literal to a loop. That removes the closure, the captured-variable cells and the `call_ref`.
   - **Estimate:** 2× per element on V8 and 3.6× on wasmtime. On the shipped scene on wasmtime
     the path is 40% of samples, so ~25–30% of that scene's wasmtime time. On ×10, 3–13%.
5. **Union-box elision** (S–M).
   - **Change:** when a `T | undefined` from `Map.get` (multi-value `(i32, T)` already) is
     consumed at once by `??`, `=== undefined` or a narrowing `if`, branch on the i32 and skip
     the `struct.new`.
   - **Scale:** 2,658 boxes a tick on ×10 at ~2–5 ns each ≈ 5–13 µs (2%).
6. **Exception polls and null checks** (M).
   - **Change:** throwing null checks on receivers that are provably non-null (class fields set
     in the constructor, `readonly`), and fewer pending-exception polls (exception handling,
     already enabled in both hosts, could replace the flag protocol).
   - **Measured:** 0–8%, most of it on C-like code (clike ×10 V8 −8% with noexc).
7. **Allocation-free `Math.cos`/`sin`** (S). `__ieee754_rem_pio2` allocates a scratch `f64`
   array per call: 80 allocations a tick in every C-like variant. `Math.cos` costs 2× Node.
8. **Scalar replacement / multi-value returns for tuples** (L). −2.6% here: tsinter's tuple
   allocation is already as cheap as V8's. It would matter for vector-math-heavy code; this
   scene isn't that.

### Host-side (Playweft, not tsinter)

- **Build wtrun `--release`:** 1.3–1.5×.
- **Set `gc_heap_initial_size`** to 8–64 MiB: −25% on the shipped scene, −30% on ×10. Forest
  Ruin is ±5%.
- **Keep the copying collector.** DRC is 3–8× slower on this code.

## 8. Compiler cost vs code-style cost, and the C-like ceiling

| | ×10 V8 | ×10 wasmtime | shipped V8 | shipped wasmtime |
|---|---|---|---|---|
| Shipped code, tsinter main | 311 | 612 | 11.4 | 37.3 |
| Shipped code, all emulated compiler opts (lit + noexc + nonull) | 233 (−25%) | 573 (−6%) | 9.1 | 33.8 |
| C-like rewrite of pw.ts, tsinter main | 52.6 (−83%) | 77.7 (−87%) | 3.8 | 5.8 |
| C-like + emulated i32 + all | 27.5 (−91%) | 44.2 (−93%) | 2.7 | 4.3 |
| Node on the shipped code / the C-like code | 104 / 17.2 | | 9.4 / 4.4 | |

- **Code style dominates.** On today's tsinter, the C-like rewrite of the stand-in engine alone
  is a 5.9× win on V8 and 7.9× on wasmtime (×10). The compiler optimizations that fit the
  shipped code are worth 1.3×.
  - The rewrite resolves `"comp.name"` to a slot once per field handle, not on every access.
  - It stores values in `number[]` instead of `Map<string, …>`.
  - It tests kinds with a bitmask instead of `indexOf` over strings.
  - It keeps closures out of per-object loops.
  - In Playweft terms: what the engine API hands game code (`pw.field(...)`) should be a
    resolved handle. Then typed game code compiles to field loads.
- **How close to C-like speed:**
  - **Shipped scene:** the C-like code on tsinter today already beats Node's JIT on V8 (3.8
    against 4.4 µs). It sits at 1.3× Node on wasmtime.
  - **×10:** tsinter today is 3.1× Node on V8 and 4.5× on wasmtime. With i32 lowering plus the
    small items, that is 1.6× Node on V8 and 2.6× on wasmtime.
  - **Native code:** no hand-written C version was measured. Node's JIT on the C-like code is the
    measured proxy. The wasm-native lane runs the C-like ×10 at 45 µs.
  - **What likely stays after that** (not isolated): the two-level array representation (a
    header struct, then the backing array, so two dependent loads per element) and the
    remaining f64 work outside the patched functions.
  - **What would close it:** i32 lowering is the item that moves typed code toward C. The
    string items matter only for code that keeps string-keyed lookups on the hot path.

## Reproducing

The harness is Playweft's (`TSINTER=<checkout> bash tools/tsinter-spike/run.sh`, with wtrun
built `--release`). The investigation scripts (none committed):

- the wtrun copy with knobs;
- the WAT counter instrumentation and the optimization-emulating WAT rewrite;
- the source variants and `micro.ts`;
- the interleaved best-of-N runner.

They lived in a session scratch directory. Each is small enough to rebuild from the descriptions
in sections 2–5.
