# U8: speed of dynamic objects (shapes, inline caches, unboxed reads)

Status: approved by Joe on 2026-11-26 (§11), written on main `0c18e62a`. U8a is in progress.
This is the U8 row of [dynamic-values.md](./dynamic-values.md) §6 (risk 6 in §7, J5 in
§8). The budget is **probe b2 within 3× of probe b1 on the wasm lane**, and on
wasm-native, which shares the runtime (it is the same wasm module translated to C by
`backend/wasm2c.ts`). Everything below applies to both lanes without extra work.

## 1. How dynamic objects work today

A dynamic value is the immutable box `$dyn { kind: i32, num: f64, ref: eq }`
(dyn.ts:1-140 header, kinds `DK` at dyn.ts:159, fields at dyn.ts:189). An OBJ box's
`ref` is a payload struct:

| piece | where | what it does |
|---|---|---|
| storage | `$dynObj { len, entries, proto, idh? }` dyn.ts:863; entry `{ key (imm), value (mut) }` dyn.ts:846 | a flat array of entry structs in insertion order |
| linked payload | `$dynObjLinked <: $dynObj` dyn.ts:2330, adding a mutable prototype box and, with the object model live, a hidden-entry table and a flags word (objmodel.ts:1-25) | `Object.create`, ES5 constructors, attributes |
| key lookup | `emitObjGetBody` dyn.ts:2886: a linear scan calling `strEq` on each entry; `ownIdx`/`ownEntry` objmodel.ts:189/292 scan both tables | `strEq` has a `ref.eq` fast path, but keys from `JSON.parse` are fresh arrays, so every probe compares contents |
| prototype chain | `memberLookup` dyn.ts:2587 loops `objGetRaw` then `protoBox` objmodel.ts:855 / `protoOf` dyn.ts:2526 | `setProto` objmodel.ts:2705 writes the link |
| attributes | `$dynEntryA` subtype with F_RO/F_NC/F_HID flags (objmodel.ts:100); `define` objmodel.ts:1149; `deleteKey` objmodel.ts:2487 | non-enumerable keys live in the hidden table |
| accessors | the A2 cell: a `$dyn` tagged `DK.JSVAL` whose `ref` is the getter's FUNC box; `$dynAcc` adds a setter (objmodel.ts:113). `isAccessorCell` dyn.ts:2723, `callGetter` dyn.ts:2544 | stored as the entry's value |
| key order | storage keeps insertion order; the walkers put integer-like keys first (`idxKey` dyn.ts:9854, `objWalk` dyn.ts:10760, `forInKeys` objmodel.ts:2895) | `JSON.stringify` and `inspect` read through `objWalk` (json.ts:5425) |
| number boxing | `boxNum` dyn.ts:3678 is a `struct.new $dyn` | each NUM entry holds its own box |
| writers of the entry table | `objPutBody` dyn.ts:3000-3090 (append and grow), objmodel.ts:270-610 (hidden-table moves, delete, `$dynEntryA` replacement) and objmodel.ts:1286; `ENTRY_VALUE` is written at two sites, both in dyn.ts | about 130 lines read `OBJ_ENTRIES`/`OBJ_LEN` directly (dyn 47, objmodel 41, emitter 31, inspect 7, fs-ladders 5), but only these few write it. Payloads are built only by `pushNewObj`/`pushNewLinkedObj` (dyn.ts:900/2366) plus the URL, RegExp and Map stand-in subtypes |

**Codegen.**
- *Reads:* a named read is `jsOp getProp` (emitter.ts:35240) or `dynKeyGet`
  (emitter.ts:32441). Either way the emitter pushes a pooled literal key and calls
  `dyn.keyGet` (dispatch: dyn.ts:4816, raw at dyn.ts:8060). Before it reaches the scan,
  `keyGet` checks the kind, a BigInt fence, symbol, typed-array and nullish-receiver
  arms, an Object.prototype stand-in fence, the error marker, and URL/RegExp arms (OBJ
  arm at dyn.ts:8191, scan at dyn.ts:8337).
  `emitDynGetProp` (emitter.ts:42496) sends names that a prototype table models to the
  `protoFenceGetPropHelper` instead.
- *Typed leaves:* `const a: number = p.a` is `dynCheck(f64, keyGet)` (emitter.ts:32330).
  The check reads the stored box's kind and `num` inline and allocates nothing.
- *Writes:* `jsOp setProp` (emitter.ts:35308) calls `keySet` (dyn.ts:8916), and a typed
  right-hand side is boxed first.
- *Calls:* `jsOp callMethod` (emitter.ts:35686) calls `dyn.invoke(name)` (dyn.ts:5011,
  5284). That looks the member up, builds an argument vector, then `callFn`
  (dyn.ts:3224) pushes `this` (dyn.ts:3549) and calls the FUNC box's per-signature
  thunk (`thunkSig` dyn.ts:3106, `$dynFn` dyn.ts:3116). The thunk unboxes and checks
  each argument and boxes the result.
- *Arithmetic in the `any` world:* `jsOp add/sub/…` (emitter.ts:35448/35489) boxes
  every intermediate result.
- *Keyed reads in TypeScript:* `checkedDynKeyGet` (lower-exprs.ts:10327) routes
  `o[k]` through the `%idx.inherited` helper (lower-exprs.ts:10356, emitter.ts:43431).
  That helper marshals `k` to a jsval, so `xs[i]` with a numeric `i` misses the
  island-array fast path (`emitIslandNumIndex`). It boxes `i`, converts it to a string
  with `toStrUser`, and `keyGet` parses the string back with `canonIdx`.
- *JSON.parse:* `jobject` (json.ts:1496) runs `pushNewObj` and then `objPut` per key,
  which scans for duplicates.
- *Object literals:* `dynObjLit` (emitter.ts:32847) does the same.

## 2. Baseline (main `0c18e62a`, this box, Node v24.18.1)

Probes: 1,000 four-key records, built as JSON text in the program and parsed.
**5,000 rounds = 20M operations**, ten times the design doc's 2M, so that the timing is
above the noise. Each time is the median of 5 runs of the 5,000-round build minus the
median of the 0-round build, which cancels out parsing, instantiation and start-up. The
wasm lane runs under Node's V8 through `tests/bench/run-wasm.mjs`. Every lane's output
matched Node's. The scripts are `tests/bench/u8/gen.mjs` and `tests/bench/u8/bench.mjs`,
and the probes' 5,000-round forms are in `tests/bench/programs` (§9).

| probe | what | Node | wasm | wasm-native | wasm ÷ typed |
|---|---|---|---|---|---|
| b1 | typed copy (`as P[]`, U2b typed arm), 4 reads/record | 10.3 ms | **29.0 ms** | 6.1 ms | 1× |
| b2 | `xs: any`, typed leaves `const a: number = p.a` | 7.7 | **399.1** | 325.8 | **13.8×** (native 53×) |
| b2any | `s: any = s + p.a + …` (boxing per op) | 19.2 | 665.2 | 498.5 | 22.9× |
| w | 4 writes/record into existing keys | 4.2 | 512.7 | 417.9 | 16.8× vs w1 (30.6 / 6.9) |
| m | `lib.add(s, i)` on an `any` literal, 20M calls | 52.8 | 924.4 | 1217.6 | 8.0× vs m1 (115.3 / 25.8) |
| poly2 | one read site sees 2 key orders | 14.5 | 376.0 | 362.2 | 13.0× |
| poly4 | 4 shapes (orders, an extra key) | 14.7 | 345.1 | 333.5 | 11.9× |

**Where b2's 399 ms goes** (wasm, 5M loop iterations, probes `len`/`hoist`/`b2a`/`b2d`):

| cost | ms | per op | cause |
|---|---|---|---|
| `i < xs.length` | 86 | 17 ns/iter | boxes `i` (`dyn.from:f64`), boxes the length, then a generic relational op |
| `xs[i]` (bound hoisted) | ~110 | 22 ns/iter | the `%idx.inherited` path above: a box, a number-to-string conversion, a string-to-index parse |
| 4 key reads | ~200 | 4.7 ns (1st key) to 7 ns (4th key) | `keyGet`'s guard ladder, a call, and a content-compare scan |

So **about half of b2 is loop plumbing on `any`, not property lookup.** No probe
allocates on the read itself. The "one `$dyn` box per number read" that the design
doc names is the index and length boxing here, plus the per-operation boxing in b2any.

## 3. The shape model

**Representation: shape-tagged entry tables, not separate value slots.** `$dynObj`
gets one mutable field, `shape: (ref null $shape)`. The entry table stays exactly as it
is: entry structs in insertion order. A non-null shape is a *promise* that entry `i`'s
key is `shape.keys[i]`, that `len = shape.count`, that every entry is a plain writable
data entry (no `$dynEntryA`, no accessor cell), that there is no hidden table and that
the object is extensible. **Null means dictionary mode, which is exactly today's
behavior.**

Why not V8's layout, with keys only in the map and values in a separate slot array?
That layout would rewrite the ~130 places that read the table, and every walker
(keys, for-in, JSON, inspect, spread, assign) would have to be re-proved. Keeping the
table means no walker changes and Node's printed key order is preserved by
construction. The cost is one extra load per hit (the entry struct). A slot-array
layout can come later as its own unit if profiles show that load matters.

```
$shape { parent: ref null $shape, key: str, count: i32,
         root: i32 | ref,  -- the prototype identity (see §5)
         kids: mut ref null $kids, kid0Key: mut str, kid0: mut ref null $shape }
```

- **Transitions.** Appending key `k` to an object with shape S looks up S's child
  for `k`. It checks the one-entry cache `kid0` first (by `ref.eq` and then `strEq`),
  then a small array `kids`. A miss creates the child. The child's `key` is the
  **canonical key string**, and the appended entry stores that same reference, so later
  `strEq` calls on that key take the `ref.eq` fast path. String identity cannot be
  observed (S002).
- **Dictionary fallback** (shape set to null, never set again) happens on any write
  through a path that does not maintain shapes. These are the fail-safe default:
  - `delete`. One exception: deleting the last-added key rolls back to `parent`.
  - `defineProperty`, any attribute change, freeze/seal/preventExtensions.
  - A hidden key, or an accessor cell appended by an object literal's `get x()`.
  - A reserved `%…` or symbol key, which covers the error encoding (S021).
  - `setPrototypeOf` / `__proto__=`.
  - More than 64 keys (depth cap), a parent with more than 32 children
    (map-like objects), or more than 65,536 shapes in total.
- **Exotic payloads never get a shape**: the URL, RegExp, Map/WeakMap/WeakSet
  stand-ins, the template-strings object, the Object.prototype stand-in and the error
  prototype objects. `keyGet` answers these through special arms before its scan, so
  an IC hit would skip those arms. Views (`$dynView`) and typed arrays are not
  `$dynObj`, so the IC's cast already fails for them.
- **Numeric and index keys** need no special case. A shape records insertion order,
  just as storage does, and the walkers already reorder integer-like keys.
- **Duplicate keys** (`{"a":1,"a":2}`, a repeated literal key) replace the value in
  place, as `objPut` does today. The shape does not change.

## 4. Inline caches

**Placement.** Each property site whose key is a compile-time literal gets one
immutable global holding a mutable `$ic` struct. The struct is created by a constant
`struct.new` in the global's initializer, so nothing is built at run time. These sites
are:
- named `getProp`/`dynKeyGet`/`setProp`;
- `callMethod`;
- `dynCheck(scalar, keyGet)`, the fused typed leaf.

Literal-key `o["k"]` sites are the same as named ones. Computed keys keep calling
`keyGet`.

```
$ic { s0, s1, s2, s3: mut ref null $shape; i0, i1, i2, i3: mut i32; state: mut i32 }
```

- **Monomorphic fast path, inline at the site.** Check the box's `ref` with
  `br_on_cast_fail $dynObj`, load `shape`, compare it with `ic.s0` by `ref.eq`, then
  read `entries[ic.i0].value`. That is about 35 bytes and no call.
- **Polymorphic (2-4 shapes).** On a miss, call one shared helper,
  `icGet(box, key, ic)`. It checks `s1`–`s3`, and on a total miss it runs the existing
  `keyGet`. If the answer came from an own plain data entry of a shaped object, it
  fills the next free way.
- **Megamorphic.** A fifth shape sets `state = MEGA`. From then on the site calls
  `keyGet` directly, which is today's speed, so there is no regression. A global
  (shape, key) stub cache is possible later but is not part of U8.
- **Null and undefined receivers, `?.`, and exceptions** always go to the slow path,
  so Node's messages and `opt` short-circuiting do not change.

**Writes.** If the cached entry exists (same check), the fast path is a `struct.set`
of the entry value. Shape guarantees the entry is writable, the object is not frozen
and it is not exotic. An **append IC** caches (S before → S after). It is valid only in
three cases:
- without a linked prototype, where nothing up the chain can hold a setter or a
  read-only key;
- with the prototype epoch unchanged (§5);
- when the slow path saw no setter or read-only `k` on the chain at fill time.

**Object literals and JSON.parse.**
- **Object literals.** A literal site caches the *final* shape of its key sequence.
  After the first build, it uses `objAppend` without scanning for duplicates, because
  its keys are known to be distinct, and stamps the final shape.
- **JSON.parse.** It walks transitions from the root as it parses. Records with one
  key sequence therefore share one shape, and their keys share the canonical strings,
  which also saves one string per key per record.

**Unboxed f64 reads into typed leaves.** At the fused `dynCheck(f64|bool|string,
getProp)` site, the hit path reads the entry's box and checks `kind == NUM`. It then
reads `num` straight into the typed local, with no call and no result box. The one
remaining box per number is the one stored in the entry. Entries keep `$dyn` refs, a
consequence of keeping the table.

**Where the boxing goes away** (sub-units a and f):
- **Loop plumbing:**
  - a numeric `o[k]` skips `%idx.inherited`, because a canonical index string is never
    an inherited method name, so the S015 fence is unaffected;
  - `x.length` feeding a typed number reads the length unboxed;
  - a relational or arithmetic op between typed `number` and a jsval tests
    `kind == NUM` inline and works in f64.
- **The `any` world:** a tree of `jsOp` arithmetic is computed in f64 when every leaf
  is NUM and boxed once at the root, instead of once per operator.
- **Writes:** small-integer boxes (0–1023) are interned, as `true`/`false` already
  are. This cannot be observed, because strict equality compares scalars by value
  (dyn.ts header).

**Method calls (sub-unit e).** `callMethod` uses the read IC to find the FUNC box. A
FUNC box then carries one more field, a **direct entry**: a per-signature thunk with
the type `(clos, recv, a0..aN-1) → dyn` for its declared arity N ≤ 4. A site whose
argument count equals the arity casts the entry and calls it with boxed arguments.
This removes the argument vector and the vector-walking validation. Any other count,
or a placeholder FUNC, keeps `callFn`.

## 5. Prototype writes (risk 6)

Own-property hits depend only on the receiver's shape. What depends on the prototype
chain is reads that answer from a prototype (ES5 `P.prototype.m`) and "absent" answers.
These work as follows:

1. **A shape implies its prototype.** Shape roots are per prototype:
   - without linked prototypes, one root per proto code (plain or null);
   - with them, a root created lazily per prototype *object* and stored on that
     object's linked payload.

   `setPrototypeOf` moves the object to dictionary mode, so a shape never outlives a
   change of its object's prototype.
2. **A global `protoEpoch` counter.** Any object that becomes a prototype gets a flag
   bit in the object-model flags word. The ways it can become one are `Object.create`,
   `setPrototypeOf`/`__proto__`, and `construct` reading `F.prototype`. Every
   key-structure change on a flagged object bumps the epoch: append, delete, define,
   attribute change, its own `setProto`, or a data entry turning into an accessor.
   Replacing a value in place does not bump the epoch, because the IC caches *where* a
   member is (holder and index), not its value.
3. **A proto-hit IC entry** holds (receiver shape, holder object, holder index, epoch).
   A hit requires the shape and the epoch to be equal. A shadowing write on the
   receiver changes the receiver's shape, so the IC misses. A write anywhere up the
   chain bumps the epoch.

The epoch is coarse: one prototype write invalidates every proto IC. ES5 code fills
its prototypes at start-up and then leaves them alone. A program that keeps mutating
prototypes falls back to the slow path, at today's speed plus one compare. Modules
without the object model have no mutable links, so they need no epoch at all.

## 6. What must stay Node-exact

None of this changes what a program can observe. Every IC hit returns what `keyGet`
or `keySet` would have returned, and the rows in §9 check that. In particular:
- **Key order** (integer-like keys first, then insertion order, then symbols) stays
  unchanged, because storage order is unchanged.
- **Walkers:** `Object.keys`/`entries`/`getOwnPropertyNames`, for-in (with inherited
  enumerable keys), `JSON.stringify`, `inspect` and spread/`assign` read the table as
  they do today.
- **`in` and `hasOwn`** use the existing lookups. They are not cached in U8.
- **`delete`** moves the object to dictionary mode, or rolls back for the last key.
  Later reads at a warm site miss and re-scan, so a deleted key reads `undefined`.
- **Getters and setters:**
  - An accessor is never cached as data.
  - `defineProperty` that turns a hot data key into an accessor moves the object to
    dictionary mode, so the next read calls the getter.
  - A setter on the prototype blocks the append IC (§4).
- **Read-only and frozen objects:** the strict-mode TypeError comes from the slow path,
  because such objects have no shape.
- **Error messages:** nullish receivers, `?.`, S015/S043 prototype fences, S138 error
  fences and S115 view fences all stay on the paths they use today.

**SEMANTICS entries: none needed.** Shapes, caps, interned small-integer boxes and
canonical key strings cannot be observed.

## 7. Code size

- Modules without a dynamic object build nothing new and stay byte-identical (the
  `s1` rule of dynamic-values.md §5).
- In modules that build OBJ, each literal-key site gains one global (with a 6-byte
  constant initializer) and about 35 bytes of inline fast path. Today a site is about
  28 bytes (pooled literal, call, pending check).
- The shared helpers (`icGet`, `icSet`, transitions, the epoch) cost a few KB per
  module.
- **Guess:** +3–8% on dynamic-heavy modules (a module with 5,000 sites gains about
  200 KB before compression). If that is too much, inline only inside loops and give
  other sites a 10-byte call to `icGet` (lead's call 3).

## 8. Sub-units

Each sub-unit lands on its own with rows on both lanes. The targets are wasm-lane
times on the 20M-op probes on this box (b1 = 29 ms), and the instrumented counts of §9
must also hold.

| unit | content | must hit |
|---|---|---|
| **U8a** loop plumbing on `any` | numeric keys skip `%idx.inherited`; `length` and typed/jsval relational and arithmetic ops run unboxed with an inline NUM test | `hoist` probe ≤ 15 ms (from 110); `len` ≤ 10 ms (from 86); b2 ≤ 220 ms; **zero `$dyn` allocations per iteration** of `for (i < xs.length) xs[i]` |
| **U8b** shapes + monomorphic read IC | `$shape`, transitions, dictionary fallback, exotic payloads unshaped; JSON.parse transitions and canonical keys; fused unboxed typed leaves; the shape-check mode | **b2 ≤ 3× b1 (≤ 87 ms)**; ≤ 1 miss per site per shape; JSON.parse of 1,000 one-sequence records creates 4 shapes; native b2 reported |
| **U8c** polymorphic + write ICs + literal shapes | 4-way ICs, megamorphic state, existing-key store IC, append IC (no linked prototype), final-shape object literals, small-integer box interning | poly2 ≤ 1.25× and poly4 ≤ 1.5× U8b's b2; **w ≤ 3× w1 (≤ 92 ms)** |
| **U8d** prototype ICs | proto roots, the prototype flag, `protoEpoch`, proto-hit and absent ICs; append IC under linked prototypes | new probe `e5` (ES5 constructor, 20M prototype-method reads): ≥ 99.9% hits, ≤ 2× an own read; rows that mutate a prototype mid-loop |
| **U8e** calls | IC'd method lookup, direct-arity FUNC entries | **m ≤ 3× m1 (≤ 346 ms)**; zero argument vectors per call |
| **U8f** `any` arithmetic | f64 operator trees, boxed once | b2any ≤ 1.5× U8b's b2; one box per statement (counter) |

The order follows payoff. U8a is about half of b2 by itself and needs no shapes. U8d
can move ahead of U8c if ES5 packages (U4) are the next speed target. Native targets
are in Decision J1.

## 9. Test plan

**Rows** (differential against Node on wasm and wasm-native, new
`wasm-u8-*.test.ts` files): each row warms an IC site past its fill, then changes the
object and keeps running the same site.
- `delete` mid-loop (last key and middle key).
- `defineProperty` turning a hot key into a getter, a read-only key, or a hidden key.
- freeze, then a strict write.
- `setPrototypeOf` mid-loop; a key added to, shadowed on, or deleted from a prototype
  mid-loop (U8d).
- More than 4 shapes at a site (megamorphic).
- JSON duplicate keys; a `__proto__` key in JSON.
- Integer-like and string keys, checking print, keys, for-in and stringify order
  after transitions.
- A literal with a getter.
- Exotic receivers at a warm site: URL, RegExp, a Map stand-in, an error, the
  template-strings object, a class view, a typed array.
- Null/undefined receivers and `?.` at a warm site; a site that throws inside a getter.
- An object passing more than 64 keys (dictionary mode).

**Perf without wall-clock asserts.** A compile option (env
`SCRIPTC_WASM_IC_STATS=1`, never on by default) adds global counters, and the program
prints them to stderr at exit. The counters are:
- IC hits, misses and megamorphic transitions per site;
- shapes created;
- `$dyn` allocations, counted in `boxNum`/`boxBool`/`boxStr`;
- argument vectors built.

Rows assert exact or bounded counts on the 2M-op probes. Example: b2 shows 8M hits,
≤ 4 misses and 0 allocations inside the loop. These counts are deterministic, so they
cannot flake.

**Shape-check mode.** `SCRIPTC_WASM_SHAPE_CHECK=1`, like `SCRIPTC_WASM_LIT_CHECK`,
re-checks `entries[i].key == shape.keys[i]` and the plain-data promise on every IC hit,
and traps if it fails. The whole corpus differential runs once in this mode per
sub-unit, on nico.

**Wall-clock.** The probes join `tests/bench/programs` (b1, b2, b2any, w, m, poly2,
poly4, e5), so `scripts/bench-lanes.mjs` reports them on every lane. They are for
people to read, not a CI gate.

## 10. Risks

1. **A writer that misses the shape leaves a stale promise.** That would be a silent
   wrong read, the worst failure for this project.
   - Mitigation: the writers are few (§1); any unaudited path drops to dictionary mode
     by default; shape-check mode runs over the corpus.
2. **The epoch's coverage (risk 6).** Every way an object becomes a prototype must set
   the flag. Missing one makes proto ICs stale.
   - Mitigation: one helper sets the flag and every link writer calls it; U8d rows
     cover each way.
3. **An exotic receiver hitting an IC** would skip the special arms in `keyGet`.
   - Mitigation: only `pushNewObj`/`pushNewLinkedObj` start a shape at the root; the
     subtypes never do; there is a row per exotic kind.
4. **The native budget may be out of reach.** Typed code on native is fast (b1 is
   0.3 ns per read), so 3× of it is about 1 ns per dynamic read. An IC hit is about 6
   dependent loads. See J1.
5. **Thrashing.** Map-like objects and prototype-heavy hot loops sit in dictionary mode
   or on the slow path. That is today's speed, not a regression, but such programs see
   no gain.
6. **Shapes are never collected** (they are reachable from the root and the IC
   globals). The 65,536-shape cap bounds this to a few MB.
7. **Code size** (§7).

## 11. Decisions for Joe

**Decided (Joe, 2026-11-26): the design is approved, with all four recommendations.**
- **J1:** the 3× bar holds on the wasm lane. On wasm-native the time is measured and
  reported, with a target of ≤ 8× typed native that does not block a merge.
- **J2:** U8a (loop plumbing) and U8e (calls) are part of U8.
- **J3:** U8f (`any`-world arithmetic) is the last sub-unit, landable alone, and may be
  dropped if U8a–e run long.
- **J4:** shapes are kept for the program's lifetime, capped at 65,536.

The probes are in `tests/bench/programs` (`u8-*.ts`, the 5,000-round forms) and their
generator and timing script in `tests/bench/u8/` (`gen.mjs`, `bench.mjs`).

The options as they were put:

**J1. The speed target on the native lane.**
- On native, typed code is about 5× faster than on wasm. Holding dynamic code to 3×
  of that would need about 1 ns per dynamic read. I don't think a compiler without a
  JIT can get there.
- If yes to 3× on native too, U8 may not finish against its own bar.
- If native gets a looser bar, the native lane stays relatively slower on `any`-heavy
  code than wasm does.
- **Recommend:** keep 3× as the bar on wasm. On native, measure and report, with a
  target of ≤ 8× typed native, and don't block a merge on it.

**J2. Include the "loop plumbing" fixes (U8a) and call speed (U8e) in U8.** The U8
row names only shapes, caches and unboxed reads.
- Without U8a, b2 cannot meet 3×, because half its time is index and length boxing.
- Without U8e, npm code that calls methods on dynamic objects stays about 8× slower
  than typed code (Node: about 1×).
- **Recommend yes to both.**

**J3. `any`-world arithmetic (U8f): now or later.**
- Code that does its arithmetic on `any` values (common in plain JS) stays about 1.7×
  slower than code with typed leaves until U8f lands.
- **Recommend:** include it as the last sub-unit, landable alone, and drop it if U8a–e
  run long.

**J4. Memory for shapes.**
- Shapes are kept for the program's lifetime. A program that makes many distinct key
  sets keeps up to 65,536 shapes (a few MB). Past that cap, new objects run at
  today's speed.
- **Recommend accepting this.**

**Process calls for the lead, not Joe:**
1. The shape field on `$dynObj` vs a slot-array layout (§3).
2. The IC struct per site vs a global IC table.
3. Inline fast paths everywhere vs inside loops only (§7).
4. Polymorphic width (4) and the caps (64 keys, 32 children, 65,536 shapes).
5. The counter and check option names.
6. A megamorphic stub cache (not in U8).
7. Rolling back a delete of the last key.
8. U8c before U8d or the reverse.
