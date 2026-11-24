# Generic methods called through a receiver: census and plan (paperclip, main caf36a79)

Design only, with no compiler code. Data: `~tsinter/.cache/tsinter-dl/top10/res/paperclip/wasm/build.log`
on nico-top (710 diagnostics), sites extracted with `build-sites.py`, plus a per-function cascade
script (`casc.js`, in this session's scratchpad `gm/`). The claims about why things fail come from
probes compiled with the caf36a79 build (local `p3`..`p8`; on nico, `~tsinter/gmprobe` against
paperclip's real `postgres@3.4.9`).

## 1. Site census

The four causes in the brief, together with the sibling cause "generic method … with no defining
object literal" (8 sites), come to 54 sites. They fall into three roots that have nothing to do
with each other, plus one stray site.

| Group | Receiver, method, and how T flows | Sites | Examples |
|---|---|---|---|
| **A** postgres.js, an ambient package type | `Sql<{}>` (5 sites), `ReservedSql<{}>` (2), and the program alias `SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">` (6). Method `unsafe<T extends any[] = Row[]>`. T is explicit or defaulted and appears only in the result `PendingQuery<T>`. | 13 "interface declaration is signature-only" | `packages/db/src/client.ts:472` `sql.unsafe("BEGIN")` (SqlExecutor), `:490` `sql.unsafe<{created_at…}[]>(…)`, `:1143` (Sql<{}> from `createUtilitySql`) |
| A, same root | Non-generic methods on the same values: `pool.reserve`, `sql.release`, `pool.end`, `sql.end` ×4 | 7 "method calls like" | `client.ts:647` `pool.reserve()`, `:722` `sql.release()`, `:1149` `sql.end()` |
| A, same root | `Sql<{}>` used as a declared type: SC2005 ×6 ("the signature keeps its type parameters"), SC2009 ×2 (`Map<string, Set<WeakRef<Sql<{}>>>>`), and "results that are themselves generic functions" ×1 (`createUtilitySql`) | 10 | `client.ts:15`, `:50`, `:60` |
| **B1** `Pick<PaperclipApiClient, …>`, a program class | `TestDriveApi = Pick<…, "get"\|"post"\|"patch"\|"delete">` and `Pick<…, "post"\|"putRaw">`. Methods `get/post/patch/delete/putRaw<T>`. T is explicit and appears only in the result `Promise<T \| null>`; the body is `this.request<T>` → `JSON.parse(…) as T`. | 13 "no compiled declaration with a body" | `cli/src/commands/test-drive.ts:301` `api.get<InstanceExperimentalSettings>(…)` (api comes from `dependencies.createApi(url)`, `:456`), `company.ts:1154` `api.post<CompanyImportTransferCreated>(…)` |
| **B2** a program type literal with only methods | `api: { get<T>(path: string): Promise<T \| null> }`, with T the same as in B1. Every value that reaches these is a `PaperclipApiClient` (`ctx.api`). | 8 "no defining object literal" | `cli/src/commands/client/token.ts:221` (`resolveAgent`), `company.ts:2006` (`listCompaniesForContext`), `run.ts:285` |
| **C** arity through an optional-parameter function value | `input.onPhase?.("x", "started")` against `(phase, status, message?: string) => void`; `owner.stop()` against `stop(clean?: boolean)`. These are not generic and have their own root. | 12 "calling a function value with N arguments" | `cli/src/commands/worktree.ts:1675` (10 sites in `seedWorktreeDatabase`), `packages/db/src/test-postgres-owner.ts:35`, `:187` |
| Stray | `(timer as { unref(): void }).unref()`, a Timeout cast to a structural type | 1 | `packages/shared/src/telemetry/client.ts:380` |

**The causes do share a representation fact, though not a root.** A type whose members are all
generic methods maps to the empty record `{}`. Record shapes exclude generic members, because no
closure slot can hold a generic function (`lower-classes.ts:3862-3870`). The token.ts S125 sites
show this directly: "a 'PaperclipApiClient' value where '{}' is expected … COPY" (`token.ts:75`).
In every site the type argument appears only in the result type, so no body needs T at run time.

**Where the blockers really are:**
- **A.** The postgres values never reach S133 (k). `Sql` is a *callable* interface (it is a tagged
  template), and the (k) check runs only for types with no call signatures. Probe `a.ts`
  (`const sql = postgres(…)` inline, `sql.unsafe<…>()`, `sql.end()`) has no refusal at the calls.
  Probe `b.ts` (`SqlExecutor`) reproduces the paperclip refusal. Both probes also hit an unrelated
  "type whose static mapping expands past 200000 steps" error at 1:1, which paperclip has once, so
  the clean result in a.ts is an indication, not proof.
- **B is mostly secondary.** In probe p6 (a class with `post<T>(path, body?: unknown)`, passed as
  `new Client()` into a `Pick<Client,…>` parameter), the refusal is "through this receiver". p8 is
  the same probe with `body: unknown`, and it compiles and runs. The per-call-site instance
  (`widthSpecializedCall`) binds the parameter to the class, and the generic call becomes a class
  generic-method call. That works only while the class's own methods lower. When they don't, the
  instance fails silently and the plain body refuses at the generic call: the M0 attribution gap
  from `s125-copy-family.md`. `cli/src/client/http.ts` has about 15 blockers of its own: "optional
  parameters of type 'any'" at :70/:77/:84, five "assignment to non-variables", `Headers` SC2020 at
  :265, SC1042 at :206, SC1101 at :269, S125 at :178/:263, and SC2009 at :101. The test-drive.ts
  sites have a second problem as well. Their receiver is produced by a function value
  (`createApi: (apiBase) => TestDriveApi`), so no instance can ever bind it to the class.
- **C** is the callValue arity fence (`lib-boundary.ts:177-191`). Its value-side twin is "functions
  with optional or defaulted parameters as values" (`lower-calls.ts:783`, 4 paperclip sites).

**Downstream unblock**, from casc.js. A function counts as freed when its remaining blockers are
only this group's sites, or SC2004 uses of freed functions.

| | Root sites | Functions freed | SC2004 freed | S125 G1/G8 sites whose callee is freed |
|---|---|---|---|---|
| A | 30 | 11 (`client.ts` migration helpers, `createUtilitySql`, `registerClient`) | 12 counted; up to 28 (all of `client.ts`'s SC2004, including 9 `uses of 'sql'` and 6 `'columnNames'`) | **0**: no G1/G8 site calls into `packages/db` |
| B | 21 | 8 on paper (`resolveAgent`, `listCompaniesForContext`, `resolveCurrentCompanyId`, `createCompanyForContext`, `uploadCompanyImportTransfer`, `wakeAgent`, `fetchLog`, `reconcileTestDriveWorktreeExecution`) | 0 | **11 of 42** (company.ts:1356/1407/1439/1756, token.ts:75/104/131, run.ts:176/243, prompt.ts:186/209), but *only once http.ts lowers* |
| C | 12 (+4 value-side) | 1 (`ownTestPostgres`); `seedWorktreeDatabase` keeps one S125 site | 0 | 0 |

The G1/G8 share is therefore about 11 sites, not most of the 42. The other 31 have callees blocked
by unrelated causes (`mergeUnknownConfigKeys`, `buildNextManifest`, `onboard`, `runWorktreeInit`,
and so on). All 11 also depend on `PaperclipApiClient` lowering, which a dispatch change alone does
not achieve.

## 2. How dispatch works today

- **Method-call ladder.** `lower-calls.ts:5060-5072` is the intrinsic chain. The object-method path
  is `lowerObjectMethodCall` (`:10977`), and its generic branch (`:11001-11004`) hands generic class
  methods to `lowerClassGenericMethodCall` (`lower-classes.ts:3893`). That function monomorphizes
  per resolved signature, as a direct `call` of `%C.m%n`. Generic methods get no vtable slot, so a
  receiver whose class could override the method must be statically exact (`genericOverrideBelow`,
  `lower-classes.ts:3826`; `exactInstanceClassOf`, `:3838`).
- **Non-class receivers** end at `lowerObjLitGenericMethodCall` (`lower-calls.ts:10848`). That
  function declines class-declared members (`:10889-10897`) and admits an interface receiver only
  as a const binding of `new C` (`:10906-10916`, with `genericIfaceBindingKeepsClass` at
  `lower-classes.ts:3875`). Otherwise it refuses, either as "interface declaration is
  signature-only" (`:10945-10956`, group A) or as "no defining object literal" (`:10957-10961`,
  group B2). Group B1's Pick receiver maps to `{}`, not to an object, so `lowerObjectMethodCall`
  declines it and the call falls through to the "no compiled declaration" refusal
  (`:5126-5140`). Anything non-generic falls through to "method calls like" (`:5141`).
- **Per-call-site instance.** `widthSpecializedCall` (`lower-calls.ts:2407`) re-lowers a plain
  function with its parameters bound to the argument types. This is the only thing that makes B
  work today, and it fails silently.
- **Package values.** On the one-world lanes, S133 (k)/(l) map a viewed package's declared
  interface or class with function members to JSVAL (`types.ts:2965-2966`, `:3729`, `:3790`). The
  island ladder (`lower-calls.ts:4088-4115`, `declaredOverDynamic`) then dispatches calls
  dynamically, and results cross into the declared types at the use. The gate at `types.ts:2965`
  requires `callSigs.length === 0`, so the callable `Sql` drops to the function mapping, which gives
  SC2005 and the generic-result refusal at `lower-calls.ts:976`. A `Pick` over it has a non-mirror
  alias symbol (`SqlExecutor`, or lib `Pick`), so (k) never matches it. The npm fence
  (`lower-island.ts:1044`) does not fire either, because a mirror-declared interface type returns
  null from `npmPackageOfSymbol` (`:1076-1083`). That is why the message reads "method calls like"
  rather than naming the package.
- **Precedent for erased instances.** Class views already call an *all-dynamic instance* of a
  per-call-site method (implicit-any JS methods, `class-views.ts:427-435`), but they fence TS
  generic methods (`:779-786`).

## 3. Mechanism per group

All of these are frontend changes, so wasm and wasm-native move together.

- **A: widen S133 (k) to callable interfaces and to homomorphic Pick/Omit.**
  1. A viewed package's declared interface with call signatures *and* function members is the
     dynamic value. Its calls and tagged templates already take the island `callFn` path
     (`lower-calls.ts:6690`).
  2. A mapped type (Pick/Omit, under any alias) is the dynamic value when every property resolves
     to a declaration of a (k)/(l) type. JS holds the same object, so nothing is copied.

  This is Node-exact: identity is kept, dispatch is dynamic, and results are checked at the use as
  S133 already does. A wrong declaration stops by name under the existing S133 text. The cost is
  dynamic dispatch on `sql.*` calls, against a database round-trip. It is risk-low, because only
  package-declared types change, under `sharedDynamic`. `WeakRef<jsval>` is already handled
  (`lower-weakref.ts:147`). The work requires amending S133 (k).
- **B: there are three options.**
  - **B-α, closed Pick-of-class.** A Pick/Omit of a *program class* whose picked members are all
    methods maps to that class's object type, not to `{}`. JS holds the instance itself, so this
    removes a copy rather than adding one, and the generic calls become ordinary class generic calls
    (exactness rules unchanged). A non-instance producer is refused by name: an object literal at
    compile time (the existing shape mismatch), and a value cast through `unknown` at run time by a
    named class check, where Node would run it. That is a divergence and needs a new S-entry. It
    is cheap, with no runtime cost. It covers the 13 B1 sites, including test-drive's
    factory-produced receivers, but only once `PaperclipApiClient` lowers.
  - **B-β, erased generic dispatch.** Generic methods would get an all-dynamic instance (T bound to
    `unknown`) in a vtable/itable slot or a view member, with the result checked into the caller's
    T. This is the general open-world answer, and it would also serve B2 without a per-call-site
    instance. The cost:
    - two instances of the same method (monomorphized and erased) whose `as T` crossings copy at
      different places;
    - a dynamic boxing of T-typed arguments, which is an S125 copy when T is a record;
    - new slot machinery in the WasmGC object layout.

    No paperclip site needs it if B-α and the per-call-site instance work.
  - **B-γ, M0 attribution only, for B2.** Once http.ts lowers, the existing per-call-site instance
    handles the 8 B2 sites (shown by probes p3/p8). The design adds a row that pins the nested
    `ctx` record argument (`listCompaniesForContext(ctx)` → `resolveCurrentCompanyId(ctx)`), which
    the probes did not test.
- **C: pad omitted optional trailing arguments with `undefined`.** For a callValue whose resolved
  signature marks the missing parameters optional, the call passes `undefined`. On the value side, a
  defaulted or optional function enters a `(x?: T)` slot as `(x: T | undefined)`, and its default
  applies on `undefined`, exactly as in JS. A JS-source callee whose body reads `arguments` keeps
  its named refusal, because `arguments.length` is the one observable difference. This is
  Node-exact, needs no S-entry, and costs nothing at run time.

## 4. Recommended sequence

Ordered by sites removed per unit of risk:

1. **GM-1, the A mechanism (S133 (k) widening).** It removes 30 root sites and 12-28 SC2004
   cascades, which frees the `client.ts` migration path. Risk is low. Before the change, the unit
   moves `declaredInterfaceOverDynamic`, `declaredClassOverDynamic` and `declaredErrorClass` out of
   `types.ts` (4770 lines) into `declared-dynamic.ts`. First step: re-probe a.ts without the
   200000-step error, and trace that error at paperclip's one site, which may be the same `Sql`
   mapping.
2. **GM-2, the C mechanism (optional-argument padding and the value-side twin).** It removes 12 + 4
   sites. Risk is low and the change is small. It lives in `lib-boundary.ts` and the
   `lower-calls.ts:783` fence. The fence's predicate moves into the new module, out of
   `lower-calls.ts` (11437 lines).
3. **GM-3, the B mechanism: B-α plus M0 attribution at generic-receiver sites, and making
   `PaperclipApiClient` lower.** It removes 21 sites and 11 G1 S125 sites, but only together with
   the http.ts blockers. Those are separate causes (optional `unknown` parameters, assignment to
   non-variables, `Headers`), which another unit may already own. B-β is deferred (Q2).

## 5. Rows and S-entries

- **GM-1**, in `packages/compiler/test/npm-declared-dynamic.test.ts` (231 lines, extended as
  DD-07…), against Node on both lanes. The row package declares a postgres-shaped callable
  interface: `interface Sql<T> { <R>(s: TemplateStringsArray, ...v: unknown[]): Promise<R[]>;
  unsafe<R extends any[] = Row[]>(q: string): Promise<R>; reserve(): Promise<Reserved<T>>;
  end(): Promise<void> }`, implemented as a JS function carrying properties. The rows cover:
  - a tagged-template call;
  - `unsafe<{n:number}[]>` with typed field reads;
  - `unsafe()` with the default type argument;
  - calls through a `Pick<ReturnType<typeof make>, "unsafe">` alias parameter;
  - `reserve()` then `release()`;
  - a `Map<string, Set<WeakRef<Sql>>>` registry;
  - `===` identity across the Pick parameter;
  - a declaration lie (`unsafe` returning a non-array), which must stop by name under S133.

  **S133 (k) amendment:** "callable declared interfaces, and Pick/Omit of (k)/(l) types, are the
  dynamic value."
- **GM-2**, corpus programs:
  - `onPhase?.(a, b)` into a 3-parameter optional type;
  - a record method `stop(clean = false)` called with no arguments through `Owner`;
  - an optional parameter after a defaulted one;
  - a JS callee reading `arguments.length`, which must still refuse by name.

  No S-entry.
- **GM-3:**
  - a `Pick<C, methods>` parameter fed by a factory function value;
  - a Pick from a subclass instance;
  - a `{…} as unknown as Pick<C,…>` value, which must stop by name;
  - `Object.keys` and `JSON.stringify` of the Pick-typed value, which must equal the instance's;
  - the nested `ctx` instance;
  - the M0 attribution text on a failing callee.

  **New S-entry:** "a Pick/Omit of a program class that holds only its methods is that class; any
  other value converted into it stops by name."

## 6. Open questions for Joe

1. **Is B worth it now?** The generic-method fix for the API client frees nothing on its own. It
   pays off only together with making `cli/src/client/http.ts` compile (about 15 unrelated
   blockers). Recommendation: do GM-1 and GM-2 first, then do B as one "API client compiles" unit.
2. **Erased generic dispatch (B-β).** It would make any interface-typed receiver with generic
   methods work, including ones paperclip doesn't have. The cost is a second compiled copy of each
   such method and slower calls through it. Recommendation: not now. No current site needs it.
3. **B-α's new divergence.** If a program types something as "the client's methods" (a Pick of a
   class) and then builds a fake object for it by a double cast, the compiled program stops with a
   named error where Node would run it. Paperclip does this only in its tests, which are not
   built. Is that acceptable, registered as a new S-entry? The alternative is B-β.
