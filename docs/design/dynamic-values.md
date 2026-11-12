# Dynamic values on the WasmGC lanes — design study

Status: written 2026-11-03 against main `72cfa8fd`. Built since: U0
(`2570365b`), U1a (`40350319`), U1b (`cbd34df1`), U2a + U2b (one unit,
2026-11-06 — see §4.3's "As built" note; SEMANTICS.md S128).
Scope: the `wasm` and `wasm-native` lanes. The c and llvm lanes are ungated and
retire at N4 (AGENTS.md), so nothing here is constrained by them.

Every claim below is either pointed at code, measured by a probe (section 9),
or marked **guess**.

---

## 0. Summary

**One root, confirmed.** The WasmGC lanes have *two* dynamic-value worlds built
over *one* runtime representation (`$dyn`, `backend/wasm/dyn.ts`):

| | the **checked-dynamic** world (`dyn` IR type) | the **island** world (`jsval` IR type) |
|---|---|---|
| who gets it | `unknown`, `object`, TS `any` **without** `--dynamic`, every JS inference residue | TS/JS `any` **with** `--dynamic`; any-bearing records and `any[]` (unit H) |
| typed → dynamic | deep COPY (S014) | live VIEW, shared (S115 a/b) |
| dynamic → typed | eager checked COPY, never refused (`dynCheck`) | fresh copy or own-view unwrap, else refused at compile time (S115 d) |
| member reads | own-only, prototype names answer `undefined` (S015) | own + prototype link (unit A2), unmodelled prototype names fenced (S043) |
| method calls | only the ~40 names in `DYN_DISPATCH_METHODS`; `this` unbound elsewhere (S042) | `jsOp callMethod`, `this` bound |
| operators | refused per site ("runs in the embedded dynamic engine") | `jsOp` add/sub/lt/eq/... natively |
| contract | "registered leniency" (S015/S016 silent answers) | JS-exact or loud (S043) |

The default build — the one the census, the round-3 survey and every non-`@dynamic`
corpus program use — is the *older* world. Its copy rule (S014) was inherited from the
C runtime's refcounted ownership, and its own text says the copy exists only for
cross-lane agreement with lanes that are now ungated. All three problems come from
that world:

1. **#120** is S014's reverse copy: `dynExitGate` applies S115(d) only under
   `--dynamic` (`frontend/lowering/lowerer.ts:2645`); otherwise `u as T` is a plain
   eager `dynCheck` copy, and S125's checker (`width-copies.ts`) does not treat
   `dynCheck` as a copy. Same family, also silent today: `const a: any = r; a.a = 2`
   leaves `r.a` at 1, a typed array put in `unknown` misses later pushes, and a typed
   callback param on a dynamic `forEach` mutates a copy (probes r1, r3, c2).
2. **Wrong-type cast after JSON.parse** fails because the cast *validates eagerly*
   (`dynCheck` or the fresh `jsExit`), and every check failure is an S122 fence.
3. **The npm `any` family** is mostly "the default build lowers `any` as the
   checked-dynamic kind": the survey ran with `dynamic: false`
   (`survey/worker.mjs:161`). The island ops the wasm emitter already implements
   natively were never reached.

**The design, in four parts.**

- **(A) One dynamic world.** On the WasmGC lanes, lower `any`, `unknown`, `object`
  and JS residue as `jsval` whether or not `--dynamic` is set. `--dynamic` then
  means only "embed the engine for package code". The island implementation is
  native already (`emitter.ts` `case "jsOp"`, ~30790), so this is mostly a
  lowering switch, plus porting the few things only the `dyn` path does
  (computed `in`, `Object.assign` on `any`, `unknown as any`).
- **(B) Maybe-dynamic typed slots ("lazily checked casts").** A local, a parameter
  or a returned value of a typed composite type `T` that receives a dynamic value
  holds *either* typed `T` *or* the dynamic value itself, decided at run time. It
  takes the typed form only where that is unobservable: the value is a view of
  exactly `T`, or a fresh value that validates against `T` with Node's key set and
  order. Anything else stays dynamic, shared like in Node. Typed reads check only
  at the leaf where a value must enter typed storage, and a failed check is a
  fence. `typeof`, `===`, printing and truthiness run on the dynamic value without
  checking, so a program's own validation runs as in Node.
- **(C) The object model on dynamic values:** property attributes (enumerable,
  writable, accessor) on dynamic objects, so `Object.keys/assign/defineProperty/
  getOwnPropertyNames`, `in`, `delete` and for-in answer as Node does. Prototype
  chains for ES5 constructors reuse unit A2's link, made mutable.
- **(D) Speed:** hidden-class shapes and per-site inline caches for dynamic objects,
  plus unboxed numeric reads. Today a dynamic property read is ~30–40× slower than a
  typed one (§5). Typed code never pays for any of A–D: all of it is gated by the
  existing module prescans, and a typed-only module is byte-identical with or
  without `--dynamic` (probe s1).

**Survey estimate** (npm, 302 packages): 233 have a site that one of the units
below removes. Units in greedy order: one world + receivers (202 packages touched),
object model (156), ES5 constructors and call/bind (162), crossings (109),
operators (104), JS inference widening (50, **guess**). After all of them, every one
of the 233 packages is free of the dynamic cluster. Few become *fully* clean (7):
they still carry `cjs:*`, `date` and other families. The per-file view is better:
+705 npm files fully clean, and +1,421 free of the cluster after the first unit
alone (§6).

---

## 1. What exists today

### 1.1 The runtime value (`backend/wasm/dyn.ts`)

- `$dyn = { kind: i32, num: f64, ref: (ref null eq) }`, immutable (dyn.ts header,
  lines 1–145). The kinds `DK` (dyn.ts:150) are a cross-lane contract with the C
  runtime: NULL 0, BOOL 1, NUM 2, STR 3, ARR 4, OBJ 5, UNDEF 6, BYTES 7, FUNC 8,
  HANDLE 9, PROMISE 10, JSVAL 11. `undefined/null/true/false` are interned globals;
  **every number read allocates a box**.
- **OBJ**: `$dynObj { len, entries, proto }` (dyn.ts:221). Entries are a flat
  `$dynEntry { key (immutable), value (mutable) }` table (dyn.ts:676), **linear
  scan**, insertion order, last write wins in place. `proto` is a code (plain /
  null-prototype / Map / WeakMap / WeakSet stand-ins), not an object.
- **Prototype link (unit A2)**: `$dynObjLinked` = `$dynObj` + an *immutable* proto
  OBJ box, built only by island `Object.create(proto)` (dyn.ts:831–870). `keyGet`,
  `invoke`, `in` and `keySet`'s accessor check walk it.
- **Accessor cells (A2)**: a getter member is an entry whose value is a `$dyn`
  tagged `DK.JSVAL` holding the getter FUNC. So the "reserved, unconstructible"
  JSVAL kind is in use.
- **ARR**: the ordinary vector type over `(ref null $dyn)` (arrays.ts), dense, no
  holes, no expandos (S016; island growth writes fence, S110 (f)).
- **FUNC**: `$dynFn { clos, thunk, sig, name, arity, src, proto-flag }`
  (dyn.ts:185–203). Per-signature thunks convert arguments (`dynFnThunk`,
  emitter.ts:18381). Own properties live in a side table keyed by closure identity
  (`$fnProps`, S016 amendment).
- **Views (unit H)**: `$dynView { token, sig, label, f0..f3 }` rides an ARR or OBJ
  box (dyn.ts:206–216, 2581–2850). The token is the static value. The accessor
  closures are compiled per static type in `frontend/lowering/island-views.ts`.
  Generic readers see a *snapshot* (`arrPayload`/`objPayload` → `arrOf`).
  Index/length/push/pop and keyed reads/writes go straight to the accessors.
  Identity compares tokens.
- **HANDLE** (net/http/fetch objects), **BYTES** (aliases, S014 amendment),
  **PROMISE**, the error encoding (`%error` key, S021/S025), URL (unit I) and
  regex payloads ride `ref` as typed structs. Flags ride payloads, never new kinds.
- Everything is **prescan-gated**: views, accessors, proto links, handles and regex
  build only in a module that can produce them (`DynDeps`, dyn.ts:283 onward).

### 1.2 The two IR types, one wasm type

- `unknown` → `DYN`, `object` → `DYN` (`frontend/types.ts:793,800`). `any` →
  `JSVAL` under `--dynamic`, else unmapped (types.ts:806). The fallback then makes
  it `DYN` for TS `any` and for all JS inference residue (`dynFallbackType`,
  `lowering/lowerer.ts:~670–700`).
- On wasm, `mapType(jsval) === mapType(dyn) === (ref null $dyn)` (dyn.ts header,
  "JSVAL"; the S014 jsMarshal amendment).
- Checked-dynamic IR nodes (`ir/nodes.ts:4889–5061`): `dynFrom` (typed → dyn,
  copying walker `dynFromHelper`, emitter.ts:16475), `dynCheck` (dyn → typed,
  validating copy `dynCheckHelper`, emitter.ts:17795, nodes.ts:5264), `dynKeyGet`,
  `dynHasKey`, `dynInvoke` (only `DYN_DISPATCH_METHODS`, lower-calls.ts:4815),
  `dynCall`, `dynTest`, `dynArrLit/ObjLit`.
- Island IR nodes (nodes.ts:5265–5418): `jsMarshal` (in), `jsExit` (out), `jsView`,
  `jsUnview`, `jsBridgePromise`, and `jsOp` over the closed `IrJsOp` set (arithmetic,
  comparisons, `instanceOf`, get/set Prop/Idx, `callMethod`, `callFn`,
  `callSpread`, `construct`, `globalGet`, literals, `objSpread`, `defineGetter`,
  `iterNew`, `optCallMethod`). On wasm all of them are emitted natively over
  `$dyn` (emitter.ts `case "jsOp"`, from ~30790). No engine is involved.
- The QuickJS engine exists on wasm only behind `__island_eval` (S103). Island
  "handles" in the lowering are locals typed `jsval` whose checker type says
  otherwise (`isIslandExpr`, `lowering/lower-island.ts` top). That rule is the
  precedent for part (B).

### 1.3 Crossings today

- **typed → dynamic.** Default build: `dynFrom` deep copy (S014; functions box,
  bytes alias). `--dynamic`: `jsView` for arrays, tuples and records, and fresh
  literals built as island literals (S115 a). Class instances, RegExp, Set/Map and
  other non-JSON values refuse (SC1101, "converting typed values to 'unknown'",
  lowerer.ts:3530–3549).
- **dynamic → typed.** `as T` lowers in `lowerAs` (lower-exprs.ts:~8452–8552).
  `jsval` sources take S115(d): own view → `jsUnview`; fresh or consumed → `jsExit`
  copy; else refused. `dyn` sources take `dynExitGate` (lowerer.ts:2644), which is
  a no-op unless `this.dynamic`, so the default build just copies. Record copies are
  width-tolerant: undeclared keys are dropped, and key order becomes the type's
  (S009, S115 d).
- **A check failure** anywhere (`expected <T> at <path>, got <kind>`) is an S122
  fence, SC1100. It cannot be caught.

## 2. The lead's prior decisions, checked against the code

| note | verdict |
|---|---|
| unit H: typed values crossing INTO `any` become live views; wrong-type writes are named errors | **True under `--dynamic` only.** Writes are now fences (S115's GH #86 amendment), not catchable errors. In the default build the crossing is still S014's deep copy, and it is silently wrong: probe r1 prints `1` where Node prints `2`, and probe r3 prints `[ 1, 2 ]` where Node prints `[ 1, 2, 3 ]`. |
| `any` → typed refused unless fresh or own view | **True under `--dynamic` only** (lowerer.ts:2645 gates on `this.dynamic`). Default build: an eager copy, never refused. That is #120 (probe p1). |
| typed package callback parameter receiving island data refused | **True under `--dynamic`** (probe c2: "a function called from dynamic code with a typed '{ a: number }' parameter…"). In the default build the same program runs and silently mutates a copy: `[ { a: 1 } ]`, where Node prints `[ { a: 2 } ]`. |

Two more facts the notes do not record:

- **S042 makes a catchable TypeError Node never throws.** In the default build, a
  JS method assigned as a property and called with `o.m()` gets `this ===
  undefined`. Probe q1 ends with "Uncaught TypeError: Cannot read properties of
  undefined (reading 'count')", where Node prints `2`. That is the class of error
  S122's ruling forbids (catchable only where Node throws). It is fixed under
  `--dynamic`.
- **Each world has holes the other lacks.** Under `--dynamic`, computed `in` (q5),
  `Object.assign(anyTarget, …)` (q7) and `unknown as any[]` (c1: "a checked cast of
  'unknown' to 'any'") are refused, while the default world handles the first two.
  The default world refuses `this`, operators, spreads and most method calls.

## 3. Where each problem comes from

**#120.** `const u: unknown = [1]` goes through `dynFrom` (or a dyn literal). `(u
as number[])` goes through `lowerAs` → `dynExitGate`, which returns the plain
`dynCheck` because the build is not `--dynamic`. `dynCheckHelper` then builds a
fresh vector, and the push lands in the copy. `width-copies.ts` lists `dynCheck` in
`RUNTIME_KINDS` (it may run callbacks) but not as a copy source (`COPY_HELPER`
covers only the width helpers), so S125's "every observable copy refuses" never
looks at it. The record form `(w as {k:number}).k = 3` behaves the same. With
`--dynamic` both are refused by S115(d), which is loud but still not Node.

**Wrong-type cast after JSON.parse.** `JSON.parse(s) as U` is fresh, so both worlds
copy at the cast: `dynCheck` by default, the fresh `jsExit` under `--dynamic`. The
copy must validate the whole value first, and a mismatch is SC1100, an S122 fence.
Probe p2 shows `tsinter: unsupported: expected string at $.id, got number`, before
the program's own `typeof v.id` test ever runs. Folding is not the issue here:
`typeof` folds by the operand's *IR* type (lower-exprs.ts ~1190–1240), so a dynamic
operand is asked at run time. The issue is *when* the check happens.

**The npm `any` family.** `worker.mjs:161` compiles with `dynamic: false`, so every
`any` and every JS residue is `DYN`, and the default world's per-site refusals fire.
Grouped by message over `results/npm.jsonl.gz` (package counts):

- method calls on dynamic receivers, 119 (`lower-calls.ts:4374`, the fallback after
  `DYN_DISPATCH_METHODS`)
- property writes through untyped receivers ("assignment to non-variables"), 126
  (`lower-stmts.ts:5132/5209`)
- for-in over `any`, 72
- typed → `unknown` conversions of non-JSON values (SC1101), 70
- `switch` on unknown, 61
- operators on `any` ("runs in the embedded dynamic engine", `anyOpFence`,
  `lowerer.ts:~2680`), 43 for `===` alone
- `delete`, 48; element reads, 46; spreads, 40+25; loose equality, 29
- the `types:shape` family is mostly the same root: 104 of its 133 npm packages
  (70 of 79 repos) carry the message "…have no static representation but run in
  the embedded dynamic engine", i.e. a record or union with an `any` inside. Unit H
  already maps those to `jsval` under `--dynamic`.

Many `stdlib:js` sites belong here too. `Object.defineProperty` alone is 174
packages, mostly on `exports` and on `any` receivers. Which receivers are `any`
cannot be told from anonymized shapes, so that split is a **guess** based on the
step-2B finding.

## 4. Design

### 4.1 (A) One dynamic world on the WasmGC lanes

- **Mapping.** When lowering for the WasmGC lanes (the same switch family as
  `undefSlots` and `hostFetch`; `analyze()` already lowers "as the WasmGC lanes
  do"), `mapType` answers `JSVAL` for `any`, `unknown`, `object` and JS residue.
  It also answers `JSVAL` for any-bearing composites, which is unit H's rule
  applied in every build. `DYN` stays as an internal IR type for the runtime's own
  surfaces (stdin chunks, option records, `dyn.*` libCalls), not as a
  user-visible world. The c and llvm lanes keep today's mapping and need
  `--dynamic` for the island, as now.
- **TypeScript's restrictions on `unknown` still hold at the checker.** A program
  can only narrow or cast an `unknown`, so mapping it to `jsval` adds no new
  surface. It changes what a cast and a crossing *mean*: they share instead of
  copying.
- **Census parity is the gate.** Every place the `dyn` path answers Node-exactly
  and the island path refuses must be ported first. Both run on the same `$dyn`
  representation, so these are mostly re-pointing the existing dyn helper
  (`dyn.hasKey`, the dyn `Object.assign/keys` arms) and adding the missing
  `jsval` → `jsval` erasure (`unknown as any`, probe c1). Then run the census both
  ways and diff.
- **Register.** Retire S014 (its body and its unit-P list), S015, S016 and S042 for
  the WasmGC lanes, leaving them as c/llvm-only. The behavior they described turns
  into S043's loud fences or into Node's answer. Every S115 rule then applies to
  `unknown` and JS too.

### 4.2 Typed → dynamic: views, unchanged and widened

S115 (a)/(b) stay as they are: live views, writes that must fit the declared type
or fence, and token identity. Part (A) makes them the default. The rest of the
crossing work (unit U5) adds view kinds for what SC1101 refuses today:

- **class instances:** a record-like view whose `get` returns methods as
  `this`-bound FUNC boxes. `instanceof` and the printed class name read the view's
  static class.
- **RegExp, Map/Set, URL, Error:** most already have dynamic payloads (regex, URL
  unit I, the error encoding). Set/Map elements of type `any` need object-identity
  keys (step 2B's finding).

### 4.3 (B) Dynamic → typed: maybe-dynamic slots

**Representation.** For a composite static type `T` (array, tuple, record, or a
union carrying one), a *maybe-dynamic* slot `T~` holds a `(ref null eq)` that is
either `T`'s own typed struct or vector, or a `$dyn`. A `ref.test $dyn` tells them
apart. Primitives never take this form: a primitive is checked at the moment it
must enter an f64, string or i32 slot, and stays a dynamic value until then.

**Which slots may be `T~` (containment).** Locals and `const` bindings; parameters,
through S125(a)'s per-call-site instance with the parameter typed `T~`; returns of
plain non-exported functions, through the same instance; and the parameters of a
closure that crosses into dynamic code, replacing the S115(d) callback refusal. A
`T~` slot is chosen statically: it is `T~` exactly when some value flowing into it
is dynamic. **Record, class and array fields and array elements never become
`T~`.** A non-fresh dynamic value bound for one of those is refused by name, as
today, so the branch cannot spread across a program (decision J4).

**Entering a `T~` slot** from a dynamic value `d` is a runtime choice, in this
order:

1. `d` is a view whose sig is exactly `T` → the typed arm, unwrapped (generalizes
   `jsUnview`; today the compiler must *prove* the own-view case).
2. `d` is statically fresh (S115(d)'s provenance rules, unchanged) and validates
   against `T` with **exactly** `T`'s key set in `T`'s order → the typed arm, as a
   copy. Nothing else holds `d`, so the copy cannot be told from it. The stricter
   key test is what removes S009/S115(d)'s width-tolerance divergence: a parsed
   object with extra keys stays dynamic and prints as Node prints it.
3. Otherwise → the dynamic arm: `d` itself, shared.

**Reading through `T~`.** Every use branches once on the arm. The typed arm is
today's code. The dynamic arm lowers the same source expression as island ops:
`v.items` is a `getProp` whose result is again maybe-dynamic, `v.items.push(x)` is
`callMethod`, and `v.k = 3` is `setProp`. A leaf that must enter typed storage
(`n: number = v.price`, `v.price * 2` into an f64, a string passed to a typed
parameter) checks the kind there. A wrong kind is an S122 fence with today's
`expected <T> at <path>` text (problem 2's "only a typed read checks"). Uses that
accept any value run on the dynamic value without a check, as Node does: `typeof`,
`===`, truthiness, template literals, `String()`, `console.log`, `JSON.stringify`,
and passing to `any`.

**#120 under this design.** `(u as number[])` has no fresh source, so it takes the
dynamic arm. `.push(2)` is the island push on the one array, and `console.log(u)`
prints `[ 1, 2 ]`. **Problem 2:** `JSON.parse(..) as U` fails validation, so it
takes the dynamic arm. `typeof v.id` asks the dynamic value and the program's own
validation runs. Only a later typed read of a non-string `id` would fence.

**Two steps.** U2a builds only the dynamic arm and the view arm. That fixes #120,
the callback-parameter refusal and the S115(d) refusals that part (A) will surface
in JS (probe b2 is ordinary JS that `--dynamic` refuses). U2b adds the speculative
fresh-copy arm. Without U2b, fresh casts of parsed JSON would read through dynamic
objects, ~30× slower (§5). Until U2b lands, fresh casts keep today's eager copy and
its fatal mismatch.

**As built (U2a + U2b, 2026-11-06; `frontend/lowering/dyn-arm.ts`, SEMANTICS.md
S128).** Where the design above was underspecified, these are the calls made:

- **No per-use branch for non-fresh values.** The design's `T~` slot holds "either
  typed or dynamic, decided at run time", with steps 1 (view) and 3 (dynamic) both
  run-time choices. As built, a non-fresh value's slot is *always* the dynamic arm,
  views included: a view reached through dynamic operations is still its static
  value (S115 (a)'s accessors, token identity), so step 1's unwrap would only be a
  speed-up, and dropping it removes every per-use branch for non-fresh slots. The
  typed arm exists only for U2b's fresh values.
- **The dynamic arm is "type the expression `any`".** A slot on the arm is a
  `jsval` binding (`dyn` in a JavaScript source, S014's U1b storage rule), and
  `Lowerer.typeOf` answers `any` for every expression rooted at it (the binding, a
  member/element read, a method call, `+`/`&&`/`||`/`??`/`?:` over one — the
  answers TypeScript gives over `any`). Every lowering that consults the checker —
  §7 item 1's folds included (presence tests, `?.`/`!` elision, `Array.isArray`,
  `instanceof`, narrowing) — therefore takes U1's dynamic path and asks the value
  at run time. Leaves check where they must enter typed storage through the
  ordinary `coerceInto` exits (§7 item 2: "check only where a value enters typed
  storage" is exactly the set of coercions into non-`any` IR types).
- **Which slots: decided by S125 (c), in further lowering passes.** A first pass
  lowers as U1 did; the width-copy pass records every judged exit at a contained
  slot it refused (and, separately, the ones it accepted); `lowerToIr` lowers the
  program again with those slots on the arm, until no new one appears. Accepted
  copies take the arm too, but only if the program still compiles (else the pass
  that built wins) — so U2 is never worse than U1's copies, and a program with no
  dynamic exit lowers byte-for-byte as before. (Accepted copies in JavaScript
  sources stay copies; a JavaScript member call over a dynamic value now binds
  `this` — GH #145, S042's amendment — which the arm relies on.) After the
  second review the fitting copies also reject an absent optional key (it would
  print as `key: undefined`).
- **Parameters.** A function literal handed to dynamic code: its refused parameter
  becomes a `jsval` parameter in the next pass (this replaces S115 (d)'s callback
  refusal). A plain function called directly: S125 (a)'s per-call-site instance
  with the parameter bound to `any` (`widthSpecializedCall`). Unannotated callback
  parameters of a method called on an arm value take what the receiver holds.
  Returns, constructors, methods, generic functions and calls through a function
  value are not contained (refused as before, loudly).
- **Function-literal results (2026-11-11, the survey's JavaScript copies).** The
  result of a function literal handed to dynamic code is contained like its
  parameters: a refused result copy (`judgeBoxedFn`) records a `ret:<literal>`
  site, and in the next pass the literal returns `dyn` (JavaScript) or `jsval`.
  The type mapper's `dynArmResultType` hook gives every mapping of the literal's
  function type the same result, so its binding (`var __rest = function ...`),
  the closure and a direct call agree; a direct call from typed code that then
  cannot take the dynamic value fails validation and the pass falls back, as
  any arm does. Separately, the judge counts a checked copy of a dynamic value
  nothing else holds (`dynCheck` of `[]`, `Object.keys(o)`) as fresh, and an
  owned local (`ownedTyped`) as a fresh result: neither copy is observable.
  Async and generator literals are not on the arm. In the same change a
  JavaScript function's own `var` is a contained binding (`armableBinding`),
  and `widthSpecializedCall`'s dynamic-arm parameter binding applies to a
  JavaScript function's JSDoc-typed parameters (its parameter `dyn`); the
  record-width binding stays TypeScript's.
- **U2b's two arms are compiled by continuation, not per use.** At the first
  statement of the binding's list that names it, the rest of the list lowers twice
  behind one flag test (once with the binding resolving to the typed copy, once to
  the dynamic value). A module-scope binding splits the same way in every function
  body that names it, and its dynamic global is re-pointed at the typed copy's view
  once the copy exists, so code that took the dynamic arm before the value was
  known (a closure made during module init) shares the copy. Bounded: two
  speculative bindings deep; lists holding function/class/`var` declarations, labels
  or `yield`, exported bindings and reads from class field initializers keep the
  eager copy (a failed split retries without speculation).
- **The exact-fit test (`jsFits`, emitter `dynFitsHelper`).** Plain OBJ with
  exactly the declared keys in the typed record's printed order (`dynFieldOrder`),
  leaves of the declared kind (an `undefined` leaf does not fit), unions: the arm
  the checked copy would pick must fit, index-signature records never fit (the
  typed form's key order is not the object's in general), no view anywhere.
- **Review fixes (U2 review, 2026-11-06).** (1) No silent width copy anywhere U2
  is in play: a copy taken *from* an arm value, the judged copy left at a slot
  whose arm did not build, and the eager copy of a speculative binding whose
  arms did not build all go through a lenient exact-fit test (`jsFits` with
  `lenient`: no undeclared key, the type's order, declared kinds; a missing key
  is S119's undefined) and stop by name otherwise. (2) An operator over an arm
  operand whose TypeScript result type is primitive (`"n=" + v.a`, `v.a < 1`)
  exits to it; `switch` over all-literal cases and an `Error` message run on the
  arm; unannotated callbacks of an arm value's methods take and return dynamic
  values. (3) Code size: a split duplicates only the statements from the first
  read of the binding through the last (extended over bindings they declare that
  are read later), and a region that reads a second speculative binding, is too
  deep, cannot be lowered twice, or is over the function's budget (the size of
  its first region) lowers once on the dynamic arm. Measured on the review's
  probes: 150 functions with one fresh cast each, 139 KB before U2, 398 KB with
  U2 (two arms are inherently ~2.9× here: the dynamic code is ~2.2× the typed);
  two local casts plus a module one per function, 180 KB before U2, 2.1 MB at the
  first U2 build, 449 KB now (compile 4.8 s → 1.3 s).
- **Key order (GH #132, 2026-11-10).** With records keeping their own key order
  (an order slot off the declared-order fast path), the lenient fit also takes an
  absent *optional* key (the copy keeps the absence, and a later write puts the
  key last, as in Node) and refuses an optional key held as `undefined` (Node's
  own key, which the copy would drop). Everything a declaration builds out of an
  arm value stays on the arm or is guarded: `{ ...v }` is `any` to TypeScript and
  builds the dynamic object; the bindings of a `const`/`let` destructuring of
  `v` (members, a rest object) join the arm; and a module global so built takes
  only the guarded copy, never S115 (d)'s fresh copy, which lists keys in the
  type's order. The speculative arm's own test (U2b) stays exact: a parse missing
  an optional key takes the dynamic arm.
- **Not built (still refused or copied):** fields and elements (J4), returns of
  plain functions, generic functions, constructors and methods taking an arm
  value, `switch`/for-in over the arm (U6/U3 — the accepted copy stays there).

### 4.4 Identity

- A view and its static value are one value (tokens; unchanged).
- A typed arm built by step 2 is a copy of a value nothing else holds, so no
  identity test can see two objects.
- A dynamic arm *is* the dynamic value. `===` between a `T~` and a plain `T`
  compares the typed arm by `ref.eq`, or the dynamic arm's view token against the
  static value.
- S125(b)'s observation checker (`width-copies.ts`) learns that `jsExit`/`dynCheck`
  copies are copies (add them beside `COPY_HELPER`). This closes the S125 hole on
  its own and is the whole of stopgap U0.

### 4.5 Property access, method calls, `this`

These are the island ops as they stand. `getProp`/`getIdx` walk own entries, then
the A2 link. `callMethod` binds `this` to the receiver (the jsval path already does;
S042 retires). Prototype *method* names on non-object kinds dispatch by kind
(S023's invoke surface). Prototype members read as *values* stay fenced (S043)
until materialized. A missing key answers `undefined`, which is Node's answer.

### 4.6 (C) The object model: attributes, keys, `in`, `delete`, for-in

- **Property attributes.** Add flags to `$dynEntry` (enumerable, writable,
  configurable; accessor already exists as the cell). The alternative is a
  parallel flags array only in modules that call `defineProperty`, keeping
  prescan-gated byte identity. **Recommended:** the gated parallel array. Every key
  walker must honor enumerable: `objWalk`, for-in, JSON, inspect, spread,
  `Object.assign`, `Object.keys/values/entries`. That is the main audit.
- **The calls.** `Object.defineProperty`/`defineProperties` cover value, get/set,
  enumerable and writable (S061 and S062 retire for dynamic targets).
  `getOwnPropertyNames`/`getOwnPropertyDescriptor` follow, plus `Object.keys/
  values/entries/assign` and `getPrototypeOf`/`setPrototypeOf` on `jsval`. Then
  `delete` (removing an entry while keeping insertion order), computed `in`
  (own + chain; S015's Object.prototype-name fence stays until prototypes are
  materialized), and for-in (own enumerable keys, then the chain's, without
  duplicates).
- **ES5 constructors** (unit U4). A function declaration that is constructed with
  `new`, or whose `.prototype` is read or written, becomes a *dynamic
  constructor*:
  - `F.prototype` is created lazily in the function's `$fnProps` table, holding a
    non-enumerable `constructor` back-link.
  - `new F(a)` allocates a linked OBJ with `proto = F.prototype`, runs the body with
    that `this`, and keeps the body's result only if it is an object.
  - `instanceof` walks the chain.
  - `.call/.apply/.bind` on such functions go through the FUNC box (`apply`/`call`
    are already in the invoke surface).
  - `arguments` in a function with declared parameters makes that function take the
    island-rest ABI (S081's real array).
  - The A2 proto field must become **mutable** for `Object.setPrototypeOf`,
    `util.inherits` and `__proto__` writes.
  - Instances are ordinary dynamic objects. Recovering a struct-backed "class"
    from an ES5 pattern is a later speed option, not the first step (decision J3).

### 4.7 Composition with S125 and existing views

- S125(a)'s per-call-site instance is the vehicle for `T~` parameters. It is the
  same machinery, with one more "argument's own type": the maybe-dynamic one.
- S125(b)'s observable-copy refusals stay. They now also cover dynamic copies
  (§4.4), and they remain the rule for every slot outside §4.3's containment.
- S115(a)/(b) views are unchanged. §4.3 step 1 generalizes S115(d)'s own-view
  unwrap from "proven at compile time" to "tested at run time".
- S115(d)'s exit refusals shrink to field and element slots (containment). Locals,
  parameters and returns take the dynamic arm instead of refusing.

### 4.8 Register changes (to file before merging, per AGENTS.md)

- Retire for WasmGC (keep as c/llvm-only): S014, S015, S016, S042. Narrow S009 and
  S115(d) as §4.3 describes.
- New entry: "A maybe-dynamic typed slot checks a value only where it must enter
  typed storage; a kind that does not fit ends the program by name (S122) where
  Node runs on." This is one entry for the whole lazy-check family.
- Amend S043 as prototype values get materialized, and S061/S062 when attributes
  land.

## 5. Costs

**Typed hot paths: unaffected by construction.** Nothing in A–D changes the
representation of a value whose type never meets a dynamic one. The dynamic
helpers, views, accessors and proto links all build only in modules whose prescan
finds a producer. Measured: a typed-only program (probe s1) is **byte-identical**
with and without `--dynamic` (33,309 bytes, same sha256), and so is a JS program on
the paths both worlds share (s2, 46,487 bytes). Where typed code *does* meet
dynamic data, it pays:

- **Maybe-dynamic reads:** one `ref.test` branch per use, predictable on the typed
  arm.
- **Views:** one box allocated per crossing, and accessor calls through FUNC
  thunks for reads made from dynamic code. Generic readers snapshot (O(n) per call
  — JSON, keys, spread).
- **Dynamic objects themselves:** probe b2 runs 2,000,000 property reads on parsed
  JSON objects with 4 keys. The default dynamic path takes **306–433 ms**. The same
  loop over a typed copy (b1) takes **8–13 ms**, and Node takes 7 ms (dynamic) and
  17 ms (typed `--experimental-transform-types`). These are wall-clock drive times
  in the test host on one box, single runs, so treat them as a 30–40× order of
  magnitude, not a benchmark. The causes are the linear key scan, one `$dyn` box
  allocated per number read, and the check. This is why U2b keeps fresh JSON casts
  on the typed arm, and why U8 (shapes, inline caches, unboxed numeric reads) is
  needed before npm code is benchmarked against Node.

**Measured after U2 (2026-11-06, wasm lane, the same 2,000,000-read loop over
1,000 four-key records, host wall clock per run including instantiation, min of 7,
one noisy laptop):** typed array built in code 0.6–1.1 ms; a fresh `JSON.parse(text)
as P[]` that fits exactly (U2b's typed arm, parse + exact-fit test + copy included)
2.0–2.5 ms, against 1.3–1.9 ms for the eager copy before U2b; the same cast over
records with one undeclared key (U2b's dynamic arm, Node's keys) 43–45 ms, where the
eager copy took 1.7–2.1 ms and dropped the key (S009); a non-fresh value on U2a's
dynamic arm 44–47 ms (it was refused before U2a); plain JavaScript over the parsed
value 42–62 ms; a TypeScript `any` binding 67–101 ms. Node: 4–10 ms for every variant.
So the typed hot path is unchanged, a fitting parse pays one linear check, and the
dynamic arm runs at the existing dynamic-object speed (~20–40× typed), which is U8's
budget to close.

**Code size.**
- Part (A) pulls the island helper set into every module that uses `unknown` or JS
  residue. Such modules already pull most of the dyn set. The size delta between
  the island ops and the dyn ops has not been measured (**guess**: a few to tens of
  KB per module).
- `T~` doubles the *use sites* of each maybe-dynamic binding (two lowerings). The
  containment rule bounds this to locals, parameters and returns that actually
  receive dynamic values.
- S125(a) instances add one function body per distinct (function, argument
  representation) pair.

**Compile time.** Lowering each `T~` use twice and the extra S125 instances scale
with how much dynamic data typed code touches. Neither touches typed-only programs.
The width-copies pass gains one more copy kind. **Guess:** a low single-digit
percent on JS-heavy packages, nothing on typed programs.

## 6. Phased plan

Package and file counts come from `results/npm.jsonl.gz` and `results/repo.jsonl.gz`,
using `families.classify`. Sites are regrouped into these units by message
(regexes in §9), and past-gate (`G`) sites are left out. The survey's caveats apply
in full: masking makes these lower bounds, and fixing one unit can reveal the next
refusal. "Cluster-free" means the package or file has no site left in *any* of
these units. "Fully clean" means it has no refusal of any family.

| unit | what | npm pkgs touched (sites) | repos touched | npm cluster-free, cumulative (greedy) | npm files cluster-free, cumulative |
|---|---|---|---|---|---|
| **U0** (stopgap, small) | S125 checker counts `dynCheck`/`jsExit` copies; default-build exits follow S115(d) | — (silent-bug fix: #120, r1/r3/c2 become loud) | — | — | — |
| **U1** one world + receivers | §4.1: `any`/`unknown`/JS → `jsval` on WasmGC; port dyn-only answers; any-bearing types; method calls, member and element reads and writes, spreads, `this` | 202 (14,222) | 76 | 23 | 1,421 |
| **U2a** maybe-dynamic, dynamic + view arms | §4.3 steps 1 and 3; typed callback params | not measurable from the survey (ran without `--dynamic`). **Guess:** it absorbs the S115(d) refusals U1 surfaces in JS, which probe b2 shows are ordinary | — | — | — |
| **U3** object model | §4.6: attributes, defineProperty, keys/assign/getOwnPropertyNames, `in`, `delete`, for-in | 156 (3,870) | 32 | 43 | 2,581 (after U4) |
| **U4** ES5 constructors + call/apply/bind/arguments | §4.6 last item | 162 (6,327) | 29 | 86 | 2,048 (file greedy takes U4 before U3) |
| **U5** crossings | §4.2: class instances, RegExp, Set/Map of `any`, URL and other handles | 109 (2,382) | 23 | 118 | 3,082 |
| **U6** operators | `==`, switch on dynamic, mixed logical ops, relational ops on non-number/string, ToPrimitive (S104 exists) | 104 (3,067) | 20 | 183 | 3,470 |
| **U2b** speculative typed arm | §4.3 step 2: fresh casts stay fast and stop being fatal | 0 directly; removes problem 2 and S009/S115(d)'s width divergence | — | — | — |
| **U7** JS inference widening | in JS sources, a receiver whose *inferred* type lacks the member read becomes dynamic ("reading 'error' from a value of type 'boolean'") — **guess** that this is the right fix | 50 (245) | 12 | 233 | 3,575 |
| **U8** speed | hidden-class shapes for OBJ (JSON objects with one key sequence share a shape), per-site inline caches, unboxed f64 reads into typed leaves; budget: b2 within 3× of b1 | 0 (speed) | — | — | — |

Reference totals:
- npm, 302 packages: 233 have a site in some unit; 21 are clean at the start.
- npm, 8,175 files: 3,575 have a site in some unit; 1,673 are clean at the start.
- Applying U1, U6, U3, U5, U4, U7 in that order, the cumulative count of fully
  clean npm files is 228, 323, 387, 422, 690, 705.
- Fully clean packages go from 21 at the start to 28. This regrouping counts
  21 clean where the README's stricter verdict counts 11; the difference is in
  how non-language and environment sites are dropped. The other families
  (`cjs:shape`, `cjs:require`, `date`, `stdlib:node`, …) dominate the
  whole-package bar, as the survey README says.
- The "loads" bar (no unconditional module-level refusal) goes from 35 to 39
  after U1 and 50 after all units, for the same reason.
- TS repos, 106: 79 have a site in some unit. After U1 alone, 287 files are newly
  fully clean (of 20,560).

**Order and why.**
- U1 first: it is the largest unit, and the plumbing already exists.
- U2a immediately after: U1 turns silent copies into S115(d) refusals, which U2a
  turns into sharing.
- Then U3 → U4 → U5 → U6 → U7 by package greedy. The file greedy agrees, except
  that it puts U4 before U3; either order is defensible.
- U2b and U8 are speed and exactness work that no survey count measures. They
  should land before npm packages are benchmarked against Node (the "real apps +
  perf" phase).
- U0 is worth doing only if U1 does not start right away: it turns three silent
  divergences loud for about a day's work (**guess**).

## 7. Riskiest semantic questions

1. **Checker-typed folds over maybe-dynamic values.** Any lowering that trusts the
   *checker's* type on a value that is really dynamic is a silent miscompile.
   - `typeof` folds by IR type and is safe (lower-exprs.ts ~1190–1240).
   - Other folds are keyed on the checker type, and each needs an audit:
     - presence tests on required fields (`resolvePresenceTests`,
       lowerer.ts:~3446)
     - `?.`/`!` elision on non-nullable types
     - `Array.isArray` decided statically (a survey message names this)
     - `instanceof` on class types
     - narrowing that drops arms
     - S119's "elide only where presence is proven"
   - Every one must consult the IR representation. This is the single biggest
     risk of U2.
2. **Where exactly a typed read checks.** The later the check, the fewer fences,
   but the more dynamic code. Arithmetic on a field typed `number` that holds a
   string is a fence here, where Node concatenates. The rule "check only where a
   value enters typed storage" must be written down per operator class before U2
   starts.
3. **Key order and printing at the typed/dynamic seam.** §4.3 step 2's exact-keys
   test is what keeps printing Node-exact. Getting it wrong reintroduces S009's
   silent width-drop.
4. **S015 → S043 flips on `unknown`.** Today `u["toString"]` answers `undefined`
   (silently wrong). Under U1 it fences until prototype values are materialized.
   Corpus programs that pass today only because they never look may start fencing.
   Census parity catches the ones the corpus has.
5. **Property attributes reach every walker.** Missing one is silent: a
   non-enumerable key showing up in JSON or for-in.
6. **The mutable prototype link** invalidates any caching U8 adds. U8 must version
   shapes on proto writes.
7. **The DK.JSVAL tag is already taken** by A2's accessor cells. When the QuickJS
   embed (E4) brings real engine objects to the wasm lanes, their bridge needs its
   own payload marker (the "flags ride payloads" rule), not that kind id.
8. **Dynamic constructors and typed code.** A JS `function Point` that is both
   called with `new` and passed where a typed record is expected becomes a crossing
   (views of dynamic objects into typed slots, i.e. §4.3). This should be fine,
   but it is untested.

## 8. Decisions for Joe

**J1 — Make sharing the default for `any`/`unknown` on wasm and wasm-native, with
no `--dynamic` flag needed.**
- If yes: casts and `unknown`/`any` slots share objects as Node does. #120 and its
  three silent siblings (r1, r3, c2) go away. Most of the npm `any` family can be
  built. Programs that touched `unknown` change behavior toward Node's. The c and
  llvm lanes keep the old copying behavior until N4, so the lanes will disagree on
  such programs.
- If no: the default build keeps copying (silently wrong where a program looks),
  and the npm family stays refused unless users pass `--dynamic`.
- **Recommend yes.**

**J2 — How a cast handles data that does not match its type** (the "lazily checked
casts" unit you approved; this is the choice of how).
- (a) Two forms: when the data fits the type exactly it is turned into fast typed
  storage; otherwise it stays dynamic and is checked only where typed code needs a
  value. Exact and fast in the common case, but the most compiler work, and those
  bindings get roughly twice the code.
- (b) Always keep cast data dynamic. Simple and exact, but reading fields of parsed
  JSON in typed code becomes ~30× slower until the speed unit (U8) lands.
- (c) Keep today's rule: a mismatch ends the program at the cast.
- **Recommend (a)**, built in two steps (dynamic form first, fast form second).

**J3 — ES5-style constructor functions (`function Point(){}; Point.prototype.m =
…`).**
- Run them as dynamic objects now: they work broadly (162 npm packages touched),
  but their method calls and field reads run at dynamic-object speed (see U8).
- Or first build a compiler pass that turns recognizable ES5 patterns into real
  classes: faster, but narrower and slower to land.
- **Recommend dynamic objects now**, and class recovery later only where profiling
  shows it matters.

**J4 — A typed record, class or array field that would receive a shared dynamic
value.**
- Refuse such programs by name (as now).
- Or let the field hold either form, which adds a small cost to every read of that
  field across the whole program.
- **Recommend refusing for now**, and revisit if real apps hit it often.

**J5 — When the speed work on dynamic objects (U8) happens.**
- Before it lands, npm-style code that runs is ~30–40× slower than typed code on
  property-heavy loops (Node: about 2×).
- Doing it early delays coverage; doing it late means the first npm results look
  slow.
- **Recommend:** after U4 (when ES5 packages start running) and before any npm
  performance numbers are reported.

(Process calls that are the lead's, not Joe's: whether to ship U0 as a stopgap, the
census-parity method for U1, and the attribute storage layout.)

## 9. Evidence

**Probes**, on main `72cfa8fd`, built in a throwaway clone, run through
`packages/compiler/test/wasm-host.ts`, Node v24.18.1 as the oracle. "default" =
`dynamic: false`, "dyn" = `dynamic: true`.

| probe | program (abridged) | default | `--dynamic` | Node |
|---|---|---|---|---|
| p1 (#120) | `const u: unknown=[1]; (u as number[]).push(2); console.log(u)` | `[ 1 ]` | refused, S115(d) | `[ 1, 2 ]` |
| p2 | `JSON.parse('{"id":5}') as U; if (typeof v.id !== "string") …` | fence `expected string at $.id` | same | runs the program's branch |
| r1 | `const a: any = r; a.a = 2; console.log(r.a)` | `1` | `2` | `2` |
| r3 | `const u: unknown = xs; xs.push(3); console.log(u)` | `[ 1, 2 ]` | `[ 1, 2, 3 ]` | `[ 1, 2, 3 ]` |
| c2 | `data.forEach((o: {a:number}) => { o.a = 2 })`, `data: any` | `[ { a: 1 } ]` | refused (typed callback param) | `[ { a: 2 } ]` |
| c1 | `(arr as any[]).forEach(…)` with `arr: unknown` | refused SC2011 | refused ("checked cast of 'unknown' to 'any'") | runs |
| q1 | JS `o.inc = function(){ this.count++ }; x.inc()` | catchable TypeError (S042) | `2` | `2` |
| q5 | JS `k in o` | `true false` | refused (computed `in`) | `true false` |
| q7 | JS `Object.assign(t, s)` | `{ a: 1, b: 2 }` | fence (SC2020) | same as default |
| q2/q3/q4/q9 | for-in, switch, `delete`, `==` on JS values | fenced | fenced | runs |
| q6/q10 | spread of `o.items`; `o.name.toUpperCase()`, `o.list.map(...)` | q6 fenced; q10 runs | both run | runs |
| b1/b2 | 2M field reads, typed copy vs dynamic | 8–13 ms / 306–433 ms | b2 refused (S115(d) in plain JS) | 17 ms / 7 ms |
| s1/s2 | module bytes | identical across the flag (s1 typed-only, s2 JS) | | |

**Survey regrouping.** Sites are classified with `families.classify`, then
assigned to the first unit whose regex matches the message:

- U1: all of `write:untyped` except constructor-field and non-writable-binding
  messages, plus `method calls like`, `element access on (non-array|checked-dynamic)`,
  `spread (elements in a dynamic|arguments in calls through|arguments are not)`,
  `dynamic keyed reads`, `reading '…' from a value of type '(any|unknown|{})'`,
  `runs in the embedded dynamic engine`, `object spread of 'any'`,
  `assignment to non-variables as an expression`, and `types:shape` sites whose
  message says "embedded dynamic engine".
- U6: `switch statements on 'unknown'`, `switch on non-primitive`,
  `loose equality`, `logical operators on (mixed|'unknown')`,
  `comparing non-number, non-string`, `operators on 'unknown'`,
  `'number' values where '(boolean|string)' is expected`,
  `string conversions of unions with object`.
- U3: `for-in over 'any'`, `'delete' on`, `'in' with computed`,
  `'in' over index-signature`, `dyn.hasKey`, the `Object.(defineProperty|assign|
  keys|getOwnPropertyNames|getOwnPropertyDescriptor|defineProperties|freeze|values|
  entries|getPrototypeOf|setPrototypeOf)` SC2020 messages, and rest or
  destructuring over checked-dynamic sources.
- U5: `converting typed values to 'unknown'`, values held or stored in
  checked-dynamic containers, `Set elements of type 'any'`,
  `passing 'unknown' values where`, `Error messages of type 'unknown'`,
  `a checked cast of 'unknown'`, `over 'unknown' prototypes`.
- U4: the `es5:proto` and `fn:call-bind` families.
- U7: the remaining `reading '…' from a value of type` sites in `dyn:receiver`.

Cumulative counts are greedy over these six groups: at each step, the unit that
makes the most packages (or files) free of every group. The script was a throwaway
in the session scratchpad and is not kept. Rebuilding it from the list above and
`report.py`'s loader takes a few minutes.
