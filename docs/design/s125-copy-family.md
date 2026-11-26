# S125 copy family in the paperclip build: census and plan

Status: design only, written on main `caf36a79` (2026-11-24). No compiler code changes.
Sources: `~/.cache/tsinter-runs/e2e-caf36a79.log`, plus paperclip's `build.log` and
`S125_.tsv` on nico-top. Small TypeScript probes were compiled locally on the wasm lane
with the `caf36a79` build to confirm the mechanisms marked *probed*.

## 1. Site census

The histogram's seven headline S125 causes add up to about 135 sites. Counting every
distinct S125 diagnostic in `build.log` gives **156 sites**, all SC1090. The rest are
variants whose message carried a long inline type, so the histogram never grouped them.
Below, the sites are grouped by root pattern in paperclip's source: the syntactic slot,
the callee, and whether the callee has blockers of its own. *Free* is the number of sites
whose enclosing declaration has no other non-cascade diagnostic. For those sites, fixing
the S125 refusal makes the declaration lower.

| Group | Sites | Free | Root pattern | Examples (paperclip `file:line`) |
|---|---|---|---|---|
| **G1** Secondary: the callee's per-call-site instance does not lower | 36 | 20 | A dynamic-arm or wider value is passed to a plain function whose body has other blockers (generic `api.get/post` through the client, `Promise.all` shapes, SC2020). S125 (a) / U2's instance fails and falls back to the judged copy, and that copy is refused. | `cli/src/index.ts:152` `doctor(opts)`; `cli/src/commands/client/token.ts:75` `resolveAgent(ctx.api, …)`; `cli/src/config/store.ts:199` `mergePaperclipConfig(source, nextConfig)` |
| **G8** Secondary: commander `.action(declaredFn)` | 6 | 6 | S125 A4's boxed instance of a declared action does not lower, because the action's own body is blocked (onboard has 3 other blockers). | `cli/src/index.ts:141` `.action(onboard)`; `cli/src/commands/worktree.ts:4509` `.action(worktreeEnvCommand)` |
| **G2** The callee is clean, but the instance is not bound | 20 | 15 | (a) A generic callee taking an `as const` tuple into `readonly T[]` (9: `parseEnumFromEnv<T>`, `parseEnumList<T>`). This is an S125 (b) tuple-to-array copy, and it is refused because the program writes `string[]` values elsewhere. (b) The bound parameter is defaulted, `opts = {}` (3: `channelsCommand`, `update{All,One}CompanySkill`; *probed*). (c) 8 sites with no known cause yet (`connectWizard`, `setupManagedAgent`, `testDriveCommand`, …). | `cli/src/commands/onboard.ts:194`; `packages/shared/src/validators/search.ts:158`; `cli/src/index.ts:167` `channelsCommand(opts)` |
| **G3** Assignment to a `let` declared earlier | 5 | 3 | `let config: T; … config = readConfig(…)`. The `const` form shares; the deferred assignment does not (*probed*: r4 is refused, r5 is accepted). | `cli/src/commands/doctor.ts:54`; `cli/src/commands/env.ts:49`; `cli/src/commands/onboard.ts:404` |
| **G4** A cast or dynamic value in a `?:` / `??` arm | 11 | 3 | `const args = isArr ? (p.x as string[]) : []`. The cast is contained, but the conditional mixes the arm with a typed `[]`, so it falls back (*probed*, p3). Three sites are other shapes: an array-literal element and a literal field. | `cli/src/commands/heartbeat-run.ts:123`; `packages/adapters/claude-local/src/cli/format-event.ts:70`; `cli/src/commands/worktree.ts:4406` |
| **G5** A return the result arm does not cover | 14 | 11 | Async functions (6: `safeJson`, `mcpRpc`, `resolveAgent`, …; *probed*, p4). A generic method (`http.ts:178`). Plain functions whose result arm fails because a caller stores the result into an element or field (`resolveCompanySkillReference` ×3, `mergeUnknownConfigKeys` ×2). | `cli/src/client/mcp-auth.ts:108` `return value as Json`; `cli/src/commands/client/skills.ts:615`; `packages/shared/src/config-schema.ts:251` |
| **G6a** A field of an options-bag literal passed to a direct call | 12 | 5 | `runVerifiedWorktreeSeed({ sourceConfig, targetConfig, … })`, where the field receives an arm value or a wider hybrid (`config.server`). Fields never take the arm (J4) (*probed*, p5). | `cli/src/commands/worktree.ts:2388`; `cli/src/commands/configure.ts:185`; `cli/src/commands/test-drive.ts:459` |
| **G6b** clack `options: [...]` literals | 11 | 0 | A fresh array of fresh `{ value, label }` literals passed inside a literal to `@clack/prompts`'s declared `select`. It is judged "writes to values of the slot's type", so the fresh-value exemption is missed. A TypeScript-only copy of the shape is accepted (*probed*, c1), so the package boundary is involved. | `cli/src/prompts/llm.ts:19`; `cli/src/commands/onboard.ts:531`; `cli/src/commands/worktree.ts:3590` |
| **G6c** J4 proper: a returned literal's field, an element, a generic `removeUndefined` | 7 | 4 | A dynamic value stored into a literal that outlives the call. | `cli/src/commands/worktree-lib.ts:258`; `cli/src/install-store.ts:329`; `cli/src/commands/client/teams.ts:356` |
| **G7** Typed value into a dynamic slot (out-crossing copy) | 15 | 10 | Module record consts placed into `Record<string, unknown>` tool schemas, with dynamic identity elsewhere (6). `merged[key] = …`, `??` chains into an `unknown` parameter, `Promise.resolve([])`, and others. The equivalent TypeScript probe shares (p6), so a per-site trace is needed. | `packages/shared/src/browser-use.ts:125`; `packages/shared/src/config-schema.ts:247`; `packages/adapters/codex-local/src/cli/format-event.ts:127` |
| **G9** Destructuring a dynamic array or object | 6 | 3 | `const [counts] = await db.select()…` (drizzle, 4), an object rest, and a spread of a cast. | `cli/src/commands/worktree.ts:1527`; `cli/src/commands/worktree.ts:3303`; `packages/shared/src/validators/plugin.ts:233` |
| **G10** A fresh literal into a package's declared parameter | 6 | 5 | `z.iso.datetime({ offset: true })`, `pgSequence(…, {…})`, `loadDotenv({…})`. Refused as a width observer ("prints … the copy"). Also `new Set(refs as string[])` and `rows.push(record(v) as R)`. | `packages/shared/src/accounting.ts:32`; `packages/db/src/schema/chat_telegram_draft_ids.ts:7`; `cli/src/config/env.ts:61` |
| **G11** A binding whose arm does not build | 7 | 6 | A module global initialized by a typed package call, `export const x = schema.parse({…})` (2). `dynArmGlobalDecl` admits only casts, speculative bindings and `any`-typed initializers. Bindings of `await r.json() as T` (3; the probe t1 is accepted, so the cause is paperclip-specific and needs a trace). Two `as unknown as Record` bindings. | `packages/shared/src/validators/status-card.ts:54`; `cli/src/onboard-service.ts:64` |
| **Total** | **156** | **91** | | |

**SC2004 cascades.** I resolved each of the 104 SC2004 diagnostics to its declaration
syntactically, following imports between files, and collected the blockers inside that
declaration, transitively. **None depends only on S125.** Three are mixed: all three come
through `cli/src/commands/worktree.ts:3590` (G6b) together with another cause. So
removing S125 frees no cascade on its own. Its value lies in the 91 *free* sites and in
the S125-on-S125 chains inside G1: `mergeUnknownConfigKeys` (G5/G7) blocks
`mergePaperclipConfig`, which blocks `writeConfig` (G1), and `printAdapterInvoke` (G4)
blocks `heartbeat-run.ts:192` (G1).

## 2. How S125 decides today

- **Out-of-function copies (S125 b).** `fresh` and `deepFresh` in
  `width-copy-fresh.ts`; `allFresh`, `byType` and the emission in `judgeWidthSites`
  (`judge-width-sites.ts`). (Line numbers in the first draft of this note cited the
  single `width-copies.ts` that S125-J split by responsibility.)
- **Dynamic crossings (S125 c).** `judgeDynSites` in `judge-dyn-sites.ts`, with its
  reason strings (`DYN_WRITE_FROM`, `DYN_SAME`, `COPY_WRITTEN`), the in-crossing
  judgement (DYN_SAME from `dynIdentityOps` and `alias.same`), the out-crossing
  judgement, the refused-arm retry and the emission. The DYN_SAME judgement uses the
  context-insensitive unification in `dyn-alias-classes.ts`, so one helper used as a
  value merges every argument it is ever handed into one class.
- **Containment.** `noteDynArmExit` (`lowerer.ts:1881-1924` when written; since S125-K in `dyn-arm-exits.ts`, which also holds the (K) slots). Contained means a
  cast, an armable binding *initializer*, or a direct identifier-callee argument
  (1893-1898). The `ret:` slot covers only non-generic, non-async, non-generator
  functions (1905-1917).
- **Arm rounds.** `lowerer.ts:658-700`, with `DYN_ARM_ROUNDS = 6` at 565. In a build that
  does not succeed (paperclip's), every round re-adds the refused sites, and the
  diagnostics come from the last round.
- **Per-call-site instance.** `widthSpecializedCall`, `lower-calls.ts:2407-2496`. It
  rejects generic callees (2414) and defaulted or optional bound parameters (2432), and
  it skips literal arguments (2454). When the instance does not lower, the judged copy
  and its refusal come back silently. Nothing in the diagnostic says that the arm was
  tried. This is why G1, G8 and G2 (c) look like S125 problems when they are other
  blockers.
- **Other arm entry points.** `dynboxClosure` (A4) is at `lower-calls.ts:2500`.
  `dynArmGlobalDecl` is at `dyn-arm.ts:86-104`. `dynArmResultType` excludes async
  functions (`dyn-arm.ts:154-159`). J4 is stated at `dyn-arm.ts:16-19` and decided in
  `docs/design/dynamic-values.md:861`.

## 3. Mechanism per group

All of these are frontend changes, so wasm and wasm-native move together. Legacy C/LLVM is
not gated.

- **M0, arm-failure attribution (for G1, G8, G2 (c), G11).** This is not a fix. When an
  instance or arm that was tried at a site fails, the S125 diagnostic gains
  "(the dynamic arm was tried here and did not lower: <first diagnostic of that pass at
  the callee>)". The diagnostic stays SC1090 S125; only the text changes, so nothing
  diverges. It costs one map from site to first failure across the rounds. Without it,
  about 50 sites cannot be attributed, and the census cannot tell S125 work from other
  units' work.
- **M1, narrower trigger for frozen-by-type tuples (G2 (a), 9).** An `as const` tuple is
  `readonly` and so is the `readonly T[]` slot, so TypeScript code cannot write either
  side. Through the tuple-to-array copy, only identity (`===` on the array, `includes`
  of the array itself) or a write through an alias could show the difference. The
  aliases are an `any` crossing, a cast to a mutable type, or a mutable binding of the
  value. The rule: the copy is not observed when neither side's type is mutable, no
  mutable or dynamic alias of the source exists (checked through the existing
  binding-use analysis), and no identity test applies to the array type. Cost: judgement
  only, no codegen change. Risk: soundness of the alias check. A row must pin
  `MODES as unknown as string[]` being written, which must still refuse.
- **M2, fresh literals through nesting and the package boundary (G6b 11, G10 4).** A
  literal all the way down is already observable only by its keys (S125 (b)). The copy
  keeps the same own keys: optional fields left `undefined` are not own keys (S091). M2
  extends `deepFresh` / `allFresh` to literals nested in a call-argument literal headed
  for a package's declared parameter type, and to the `as const` retag. The first task is
  a row that reproduces G6b with a compiled package (`npmStatic`), because the
  TypeScript-only probe does not refuse. Cost: judgement only. Risk: low.
- **M3, arm reach for more contained slots (G3 5, G4 8, G9 5, G11 2, G2 (b) 3).** These
  reuse U2's arm with no new representation.
  - **Deferred `let`.** A `let` binding whose every assignment is a plain `=` statement
    takes the arm when any assignment's exit is refused, keyed on the declaration.
  - **Conditional arms.** `?:`, `??`, `||` and `&&` pass containment up to the slot that
    encloses them. The other operand is fresh (`[]`, `null`, `{}`) and crosses as a
    fresh dynamic value, so no copy can be observed.
  - **Array and object patterns.** A `const` pattern element without a default or rest
    becomes contained, as `forOfConstBinding` already allows for loops.
  - **Module globals.** A module global whose initializer is a viewed package's call
    (zod `parse`) takes the arm.
  - **Defaulted parameters.** A defaulted parameter binds on the arm, picking its default
    on the dynamic undefined, as the A4 extension already does for function literals.

  Cost: each armed slot's uses lower as island operations. These are cold CLI paths, and
  J5's 30-40x penalty applies only to them. Complexity: `noteDynArmExit` and
  `widthSpecializedCall`.
- **M4, options-bag literal on the arm (G6a 12).** An object literal that is the direct
  argument of a plain function, with a field receiving an arm value, is built as an
  island literal (a dynamic object) and is itself the arm site. The callee's parameter
  then binds on the arm through the existing machinery. Typed field values enter as
  S115 (a) views, so they are shared and J4 is untouched, because no typed field holds a
  dynamic value. A class-instance field still crosses by copy and stays refused by name.
  Cost: the callee reads its options dynamically. Risk: moderate; the literal's evaluation
  order and `undefined`-valued keys must match Node (S091 does not apply to an island
  literal).
- **M5, async result arm (G5 async, 6).** An async plain function's composite result
  becomes `Promise<jsval>`. `await f()` is a contained slot at each caller, and a caller
  that stores the result into a field or element keeps the refusal. Cost: the arm spreads
  across call boundaries through promises, which is the widest change here. Risk:
  moderate to high (callers must agree on every awaited site, and a
  `Promise.all`/`.then` result must stay consistent).
- **M6, J4 revisited (G6c 7, part of G5).** Let a record field or array element hold
  either form. This costs a branch on every read of that field across the whole program.
  It is Joe's decision (see Q1).
- **G7 (15) and the remainder of G11 and G2 (c).** These need M0's attribution plus a
  per-site trace before any mechanism is chosen. The TypeScript probes for the same shapes
  share or accept.
- **G1 and G8 (42).** S125 itself needs no change. These move when their callees' other
  blockers land: the units for "calls of the generic method … through this receiver"
  (26 sites in the histogram), `Promise.all` shapes and SC2020. M0 makes that visible.

## 4. Recommended sequence

Ordered by sites removed per unit of risk:

1. **Unit S125-J (judgement only): M0 + M1 + M2.** Removes about 24 sites (9 + 15), with
   20 free. No codegen change. It also needs the required split of `width-copies.ts`
   (3452 lines): moving `judgeDynSites` (2589-3440) into its own module, and the
   S125 (b) freshness and observer helpers into another. M0 lands here because every
   later unit's census depends on it.
2. **Unit S125-K (arm reach): M3.** Removes about 23 sites. It requires splitting
   `dyn-arm.ts` (839 lines) and moving `noteDynArmExit` out of `lowerer.ts` into a
   `dyn-arm-exits.ts` module (see Q3).
3. **Unit S125-L: M4, then M5.** Removes 12 + 6 sites. M5 can be dropped if its risk
   proves too high once M0's traces are in.
4. **After those:** the G7 traces, and the J4 decision (M6).

The other blocker units, with M0 in place, should then retire most of G1 and G8.

Realistic outcome: S125 goes from 156 to about 85 sites after units 1-3. About 42 of those
are secondary, and the rest are G7, J4 and untraced sites. Few declarations become fully
lowerable from S125 work alone, as the cascade analysis shows.

## 5. Rows and SEMANTICS amendments

New rows go in `packages/compiler/test/wasm-s125-reach.test.ts` (S125-K's in `wasm-s125-k-reach.test.ts`) (with `u3u4-rows.ts`),
each run against Node on wasm and wasm-native:

- **S125-J-01..04.** `parseEnum(v, MODES)` with an `as const` tuple runs, while
  `string[]` is written elsewhere. A cast alias (`MODES as unknown as string[]`) that is
  then written still refuses by name. So does a mutable `[string, string]` tuple. So does
  `===` on the array.
- **S125-J-05..07.** A clack-shaped `select({ options: [{ value: "a" as const, label }] })`
  through an `npmStatic` package runs. Its options are printed by the package as Node
  prints them. A literal later written through a kept alias still refuses.
- **S125-J-08.** An M0 diagnostic text row: an instance blocked by a named construct names
  that construct.
- **S125-K-01..08.** Deferred `let` (`r4`) with a write to the source visible through the
  binding. `?:` / `??` arms (`p3`). Array and object patterns over a dynamic array.
  A module global set from a package `parse`, with identity and writes. A defaulted
  `opts = {}` bound on the arm (`q1`), called with and without the argument.
- **S125-L-01..06.** An options bag with an arm field and a typed field, where the callee
  writes through both. The bag's key order, `undefined` values and `JSON.stringify` match
  Node. A class-instance field still refuses. For M5: `await safeJson()` written by the
  caller and seen by the original, and a result pushed into an array still refuses.

SEMANTICS.md S125 amendments, written before each merge:

- **(J)** Add to (b)/(c)'s "not observable" list: a copy between two types neither of
  which TypeScript can write (readonly tuple into readonly array), with no mutable or
  dynamic alias and no identity test on the array type. Also a fresh literal nested in a
  call-argument literal, including one headed for a package's declared type. State M0's
  added text.
- **(K)** Extend the U2 contained-slot list: a `let` assigned only by `=` statements,
  `?:`/`??`/`||`/`&&` operands of a contained slot, `const` destructuring pattern
  elements, a module global initialized by a package call, and a defaulted parameter of a
  plain function.
- **(L)** An object literal passed directly to a plain function is a dynamic object when a
  field would otherwise copy an arm value. An async plain function's composite result is
  on the arm. Fields and elements stay under J4.

## 6. Open questions for Joe

1. **J4: should typed record fields and array elements be able to hold dynamic values?**
   If yes, about 7 more paperclip sites run (plus G5's stored results). The cost is that
   every program reading such a field pays a small check on each read. If no, those sites
   keep refusing by name. Recommendation: keep J4 for now and take M4 (the options bag
   becomes a dynamic object instead), then revisit after the G7 traces.
2. **Options bags as dynamic objects (M4).** Functions handed such a bag read it at
   dynamic-object speed, which is slow per access (roughly 30-40x in hot loops, per J5).
   paperclip's bags are read once per command. Recommendation: accept.
3. **The file-size rule on 11k-line files.** Units 1-3 touch `lowerer.ts` (11,610 lines)
   and `lower-calls.ts` (11,437 lines). Read literally, the rule requires splitting both
   whole files inside these units, which would be several times the units' own size.
   Recommendation: each unit moves out the responsibility it touches (`noteDynArmExit`
   and `exactGuard` into `dyn-arm-exits.ts`, `widthSpecializedCall` and `widthInstance`
   into `width-instances.ts`), and fully splits `width-copies.ts` and `dyn-arm.ts`. The
   full splits of the two 11k-line files would be a dedicated unit Joe schedules.
4. **Secondary sites (G1/G8, 42).** They will not move through S125 work. Should
   paperclip's next units prioritize the generic-method-through-receiver blockers (26
   histogram sites), which unblock most of G1, over units 2-3 here? Recommendation:
   unit 1 first, which gives M0 the visibility, then decide using its attribution.
