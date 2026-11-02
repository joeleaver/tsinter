# Refusal survey, round 3 (main @ d4a95a74)

Which constructs tsinter refuses most often in real code, counted by **packages affected** (one idiom used 500
times in one package is one fix), so units can be ordered by frequency instead of by the 8 apps of round 2.
Measurement only: the compiler is unchanged. Nothing here is wired into a test runner.

Two strata, reported separately:

- **A. npm, 302 packages** (294 with a result): the most depended-on packages on npm, as published tarballs.
  This is what a dependency tree contains: mostly ES5/CJS/UMD and bundled JS.
- **B. TypeScript source, 106 repos**: shallow clones of popular TypeScript projects. This is what people write.

Full generated tables: [`results/tables-npm.md`](results/tables-npm.md), [`results/tables-repo.md`](results/tables-repo.md),
[`results/joint.md`](results/joint.md).

## Headline

- **Nothing real is clean.** In A, 11 packages come back with no refusal, and every one is a shim under 20
  statements (`babel`, `json-loader`, `gulp-rename`, ...). In B, 4 of 103 repos are clean. The median non-clean
  package has 7 refused families (A) or 22 (B).
- **A builds but does not run.** 185 of 287 npm packages build: all their refusals are deferred fences. But only
  29 load. The other 258 have a build-time refusal or an unconditional fence at module top level, which kills
  them at load.
- **In B, the type-check gate comes first.** 75% of TS entries stop at preflight, mostly because of the survey
  environment (see caveats). Among real refusals, the module system leads: default exports/imports (44% of repos),
  import cycles (39%), and re-exports from packages. Each blocks whole files at preflight.
- **The QuickJS fallback would change the A picture completely.** 267 of 278 non-clean npm packages import only
  builtins the island already shims. Handing the whole package to the engine could load up to 278 of 289. That is
  an upper bound: "could load", not "runs the same as Node". The `module:embedded` route (phase-2 E4) is not on
  the wasm lanes yet.
- **15 npm packages hit internal compiler errors** (SC9001), and analyze() crashed outright on 6 (3 causes). These
  are bugs, not missing features. See the crash tables below.

## 1. Verdicts

| | A: npm | B: TS repos |
|---|---|---|
| packages with a result | 294 of 302 (8 had no entry point, or the analyzer crashed on every entry) | 106 of 106 |
| clean (no refusal found) | 11, all shims under 20 statements | 1 (`eslint-config-standard`); 4 counting only sites seen before the gate |
| deferred fences only (the build passes) | 175 | 0. In TS almost every refusal is build-time |
| blocked (at least one build-time refusal or package-level fallback) | 108 | 104 |
| partial (an entry timed out or crashed) | 6 | 3 |

Top causes of a **blocked** verdict in A: bundler output (`createRequire` banners, `__toESM` helpers; 28),
module forms refused at preflight (`require()` of JSON, `export *` from packages; 17), types with no static shape
(17), internal compiler errors (15), Node builtins (`node:process`, `vm`, `v8`; 13), import cycles and
`require()` below use (12), Date (12), SC3001 WasmGC emitter refusals (11; mostly `dyn.hasKey`, GH #91).

In B, every repo hits at least one environment family (`tsc:missing-dep`, `tsc:knock-on`, `tsc:ambient`).
The language causes behind that are listed in the ranked table.

## 2. Ranked families (packages affected)

The family rules are in `families.py`. "B past-gate" counts repos where a family showed up only after the
past-gate pass, which lowers entries that failed the type check anyway (types degraded, so less reliable).
The full per-stratum tables add hard/init columns, sites per package, and named members.

| family | A pkgs | A % | A sites | B repos | B % | + B past-gate only |
|---|---|---|---|---|---|---|
| `stdlib:js` ECMAScript member with no lowering | 182 | 62% | 6024 | 70 | 66% | 30 |
| `dyn:receiver` calls/reads/for-in/switch on any or unknown receivers | 182 | 62% | 7595 | 52 | 49% | 36 |
| `write:untyped` `o.a.b = v`, `o[k] = v`, `o.n++` through untyped receivers | 166 | 56% | 6900 | 45 | 42% | 45 |
| `dep-edge` imports a package that is not compiled statically (not a construct) | 150 | 51% | 9307 | 84 | 79% | 15 |
| `types:shape` no static representation: unions with fields, intersections, `any` members, recursive records | 133 | 45% | 2594 | 79 | 75% | 21 |
| `stdlib:node` Node API member with no lowering | 110 | 37% | 745 | 64 | 60% | 31 |
| `cjs:require` `require()` off top level, as a value; `createRequire`; `import.meta` | 134 | 46% | 3486 | 24 | 23% | 38 |
| `cjs:shape` `module.exports = <non-literal>`, writes to `exports.x` | 134 | 46% | 1774 | 3 | 3% | 3 |
| `es5:proto` constructor functions, `X.prototype.m = fn`, `Object.create` | 132 | 45% | 5624 | 18 | 17% | 49 |
| `date` Date values | 108 | 37% | 1538 | 32 | 30% | 40 |
| `fn:call-bind` `.call/.apply/.bind`, `arguments` | 119 | 40% | 1229 | 19 | 18% | 26 |
| `destructure` absent fields, optional patterns, rest over dynamic values | 101 | 34% | 1374 | 21 | 20% | 50 |
| `op:any` operators on any (`\|`, `>>>`, `==`, comparisons) | 92 | 31% | 3461 | 27 | 25% | 46 |
| `generic:fn` generic methods/arrows with no monomorphized home | 44 | 15% | 475 | 35 | 33% | 40 |
| `module:default` default exports/imports (SC1012) | 4 | 1% | 4 | 47 | 44% | 0 |
| `module:form` JSON imports, re-exports from packages, `export =`, `import = require` | 17 | 6% | 20 | 51 | 48% | 1 |
| `module:cycle` import cycles (SC1016), `require()` below use (SC1013) | 12 | 4% | 25 | 41 | 39% | 0 |
| `module:builtin` Node builtin import refused (`node:process` leads) | 17 | 6% | 30 | 37 | 35% | 0 |
| `fn:value` functions as values (optional params, overloads) | 83 | 28% | 1490 | 17 | 16% | 37 |
| `obj:computed` computed-key object literals with methods/spreads | 90 | 31% | 2519 | 7 | 7% | 15 |
| `builtin:value` builtins/Math/string methods as values (#84) | 84 | 29% | 1610 | 2 | 2% | 4 |
| `error:shape` Error `cause`, catch-binding uses, `.code` reads | 25 | 9% | 102 | 27 | 25% | 30 |
| `module:ns` namespace objects as values | 63 | 21% | 1496 | 7 | 7% | 4 |
| `class:dyn` statics through a class value, extending builtins | 59 | 20% | 623 | 11 | 10% | 31 |
| `global:sniff` typeof/reads of undeclared globals (UMD, `ngDevMode`) | 54 | 18% | 1076 | 0 | 0% | 56 |
| `var:hoist` `var` read in a hoisted function above it | 53 | 18% | 3370 | 0 | 0% | 2 |
| `symbol` symbol-keyed access | 46 | 16% | 336 | 7 | 7% | 22 |
| `cfg:strict-off` tsconfig disables strictNullChecks (SC0002) | 2 | 1% | 4 | 30 | 28% | 0 |
| `types:narrow` hand-written type predicates, `??` that changes the type, tuple/string index | 5 | 2% | 10 | 22 | 21% | 17 |
| `in:computed` `in` with computed keys | 28 | 10% | 87 | 10 | 9% | 25 |
| `bundler:interop` `createRequire` banners, `__toESM` | 28 | 10% | 293 | 0 | 0% | 0 |
| `ts-emit:enum` compiled TS enums `E[E["A"] = 0] = "A"` | 22 | 7% | 1472 | 0 | 0% | 0 |
| `container:elem` Map/Set element types outside the supported kinds | 15 | 5% | 57 | 15 | 14% | 37 |
| `bigint` | 13 | 4% | 104 | 12 | 11% | 9 |
| `spread`, `expr:assign`, `generator`, `for:multi`, `generic:class`, `closure:capture`, `class:local`, `export:mutable`, `call:arity`, `decorator`, `syntax` | each 1–21 | ≤7% | | each 0–12 | ≤11% | |
| `ice` internal compiler error (SC9001) | 15 | 5% | 192 | 0 | 0% | 0 |
| `wasm:backend` SC3001 (first entry only) | 11 | 4% | 11 | 0 | 0% | 0 |
| `tsgo:panic` typescript-go checker panic (SC0004) | 2 | 1% | 2 | 10 | 9% | 13 |
| B only: `tsc:dom` no DOM lib (`window`, `document`, `HTMLElement`) | 0 | | | 72 | 68% | |
| B only: `tsc:jsx` JSX/React | 0 | | | 47 | 44% | |
| B only: `esm-in-cjs` ESM syntax in a file Node loads as CJS | 0 | | | 9 | 8% | |
| `binding:blocked` reference to a binding whose declaration was refused (knock-on) | 189 | 64% | 10131 | 39 | 37% | 57 |
| environment: `tsc:missing-dep`, `tsc:knock-on`, `tsc:ambient` | ~0 | | | 98 / 94 / 66 | | |

What the biggest families contain, by packages affected (non-past-gate sites):

- `stdlib:js` A: `Object.defineProperty` 75 (`__esModule` markers, getter re-exports, and 60 packages with other
  uses), `Set` elements of other types 51, `String.replace` with a non-string, non-function replacement 45,
  `Object.assign` 40, `new Set(iterable)` 37, `Object.getOwnPropertyNames` 32, `Object.keys` 30,
  `getOwnPropertyDescriptor` 28, `Array.from` shapes 28. B: `.toString()` 18, `new WeakMap` 17, `Array.from`
  shapes 15, `Object.assign` 13, `import()` 13, `Number.parseInt` 13, `unshift` 12, `new Set(...)` 12,
  `codePointAt` 11, `Object.freeze` 11, `String.fromCodePoint` 10, `Object.hasOwn` 10, two-argument `startsWith` 10.
- `stdlib:node` A: `require.resolve` 28, `Error.captureStackTrace` 11, `process.version(s)` 8+7, `util.inherits` 8,
  `TextDecoder`/`TextEncoder` 7/6. B: `import.meta.url` 17, `fs.renameSync` 10, `import.meta.dirname` 7,
  `fs/promises.lstat/realpath/rename` 5–6, `URL.origin/username` 6, `AbortController` 6.
- `module:builtin` B: `node:process` 12, `node:vm` 6, `node:dns/promises` 6, `vm` 5, `node:v8` 4, `console` 4.
  A: `node:process` 4.

## 3. Greedy unlock order

The unit is a package. A package counts as clean only when all its families are fixed. Each step fixes the
family that cleans the most packages now. When no single fix finishes a package, the step takes the family
with the most leverage: the sum, over blocked packages, of 1/(families left). `tsc:missing-dep`,
`tsc:knock-on` and `tsc:ambient` are counted as already fixed (they are the environment). Partial results
are left out. Full tables: section "Greedy unlock order" in each tables file.

**A, every family (deferred fences included)**, 287 packages, 11 clean at the start (all shims):

| step | fix | newly clean | cumulative | % |
|---|---|---|---|---|
| 1 | `cjs:shape` | 11 | 22 | 8% |
| 2 | `binding:blocked` (knock-on; clears once its roots are fixed) | 7 | 29 | 10% |
| 3 | `cjs:require` | 3 | 32 | 11% |
| 4 | `dyn:receiver` | 6 | 38 | 13% |
| 5 | `stdlib:node` | 5 | 43 | 15% |
| 6 | `stdlib:js` | 3 | 46 | 16% |
| 7 | `es5:proto` | 5 | 51 | 18% |
| 8 | `write:untyped` | 3 | 54 | 19% |
| 9 | `types:shape` | 4 | 58 | 20% |
| 10 | `date` | 5 | 63 | 22% |
| 11–17 | `op:any`, `module:ns`, `obj:computed`, `fn:value`, `fn:call-bind`, `destructure`, `class:dyn` | 5–7 each | 103 | 36% |
| 18–22 | `bundler:interop`, `builtin:value`, `global:sniff`, `var:hoist`, `generic:fn` | 6–10 each | 142 | 49% |
| 23–34 | `ice`, `symbol`, `ts-emit:enum`, `export:mutable`, `other`, `in:computed`, `error:shape`, `module:form`, `module:builtin`, `closure:capture`, `module:cycle`, `expr:assign` | 5–8 each | 221 | 77% |
| 35–48 | the long tail | | 287 | 100% |

This view has no cliff: half the packages need 22 families fixed. The two narrower bars move faster:

- **A, build passes** (build-time refusals only): 185 of 287 already pass. Then `ice` +14 (69%),
  `bundler:interop` +11, `module:form` +11, `wasm:backend` (`dyn.hasKey`, #91) +11, `types:shape` +8,
  `module:cycle` +9, `module:builtin` +9, which reaches 90% after seven steps.
- **A, loads** (no build refusal and no unconditional module-level fence): 29 at the start. Then `cjs:shape` +14,
  `cjs:require` +15, `write:untyped` +8, `stdlib:js` +7, `stdlib:node` +7, `es5:proto` +12, `module:ns` +9,
  `destructure` +8, `export:mutable` +8, `bundler:interop` +7, which reaches 43% after ten steps.

**B, every family (sites seen only past the gate left out)**, 103 repos, 4 clean at the start:

| step | fix | newly clean | cumulative | % |
|---|---|---|---|---|
| 1–7 | `module:form`, `tsc:dom`, `types:shape`, `module:builtin`, `cjs:shape`, `tsc:jsx`, `cfg:strict-off` | 0–2 each | 9 | 9% |
| 8 | `module:default` | 5 | 14 | 14% |
| 9 | `module:cycle` | 5 | 19 | 18% |
| 10–17 | `cjs:require`, `stdlib:node`, `other`, `stdlib:js`, `write:untyped`, `fn:value`, `dyn:receiver`, `generic:fn` | 1–3 each | 35 | 34% |
| 18–24 | `op:any`, `error:shape`, `destructure`, `types:narrow`, `esm-in-cjs`, `in:computed`, `expr:assign` | 2–3 each | 52 | 50% |

**Per file**: a whole package is a coarse unit, so the tables also run the greedy with each source file as the
unit. In B (16,044 files, 8,806 clean): `tsc:dom` takes it to 64%, `tsc:jsx` 74%, `esm-in-cjs` 79%,
`module:default` 82%, `module:cycle` 85%, `types:shape` 88%, `module:form` 90%, `stdlib:js` 92%. In A (7,760 files):
`write:untyped` 29%, `cjs:shape` 34%, `types:shape` 42%, `cjs:require` 45%, `dyn:receiver` 49%, `stdlib:js` 52%,
`es5:proto` 56%, `module:ns` 60%, `obj:computed` 64%, `destructure` 68%, `bundler:interop` 71%.

**QuickJS embed (A only):** for non-clean packages the static path above is a long haul. The engine route is
nearly all-or-nothing per package, and its bound is high: 267 of 278 non-clean packages use only shimmed
builtins. Outside the shim list are `vm` (7), `http2` (3), `repl` and `cluster` (1 each). That bound assumes
E4 lands on the wasm lanes, and it says nothing about Node-exactness. B cannot be estimated: a TS project's own
files are not routed to the engine by design.

## 4. Against the #92 queue and the 8-app census

| #92 item | survey verdict |
|---|---|
| 1 writes through untyped receivers | **stays top**: 56% of A, 42% of B, and the #1 per-file fix in A |
| 2 calls/reads on any | **stays top**: 62% of A, 49% of B |
| 3 missing stdlib | **moves to the top** of both strata (62% / 66%). It is a long list of members, though: the cheap ones (`Object.assign`, `Object.keys/getOwnPropertyNames/defineProperty`, `new Set(iter)`, `Array.from` shapes, `toString()`, `WeakMap`, `Number.parseInt`, `unshift`, `codePointAt`, `hasOwn`) cover most packages. Node members (`require.resolve`, `import.meta.url/dirname`, `Error.captureStackTrace`, `process.version`, `util.inherits`, `TextEncoder`) are a separate family at 37% / 60% |
| 4 option-bag types | **up**: `types:shape` is 45% of A and 75% of B, the top TS language family per file after DOM/JSX/module forms |
| 5 operators on any | **down slightly**: 31% / 25% |
| 6 ES5 constructors/prototypes + call/bind | **A-heavy**: 45% and 40% of A, but 17% and 18% of B |
| 7 builtins as values (#84) | **A only**: 29% of A, 2% of B |
| 8 `in` with computed key | **down**: 10% / 9% (plus `dyn.hasKey` SC3001 in 6 packages) |
| 9 CommonJS shapes | **up in A**: `cjs:shape` and `cjs:require` are 46% each, and they are the first steps of the A greedy order. They also lead the "loads" view, because they fence at module top level |
| 10 `const xs = []` | not separable here; it surfaces as `types:shape`/`other` mismatch messages |
| 11 `var` read in hoisted function | **down**: 18% of A (generated parsers and bundles), 0% of B |
| 12 generic class hierarchies | **down**: 1% of A, 7% of B (27 more past the gate) |
| 13 UMD sniffing | 18% of A as `global:sniff` (includes Angular's `ngDevMode`), 0% of B |
| 14 multi-declarator `for` | **down**: 5% / 5% |
| 15 bigint | **down**: 4% / 11% |

**New, not in #92:**

- TS module-system refusals at preflight: `export default`/default imports (44% of B), import cycles (39% of B),
  re-exports from packages, JSON named imports, `export =`/`import = require`. These block whole files, so they
  top the B per-file order after DOM/JSX.
- `tsconfig` without strictNullChecks (SC0002): 28% of B repos are refused whole. This is a policy question,
  not a lowering one.
- DOM (68% of B) and JSX (44% of B): most popular TS is browser UI. Whether `lib: dom` is in scope for the browser
  deployment target is a scoping decision for Joe.
- A-only shapes that bundlers and transpilers emit: `bundler:interop` (28 packages, all hard), compiled TS enums
  `E[E["A"]=0]="A"` (22), `export:mutable` live bindings (17).
- Internal compiler errors (15 npm packages) and analyzer crashes (6 packages). These are bugs to file.
- `dep-edge`: half of A and four fifths of B import a package that is not compiled statically. The `--npm-static`
  path and E4 decide these, not a lowering unit.

**Suggested order** (data, not a decision): (1) file the ICE and crash groups as bugs; (2) for TS, the
module-form preflight refusals (`module:default`, `module:cycle`, `module:form`), then `types:shape`,
`stdlib:js` (cheap members first) and `stdlib:node`; (3) for npm, `cjs:shape` + `cjs:require` (the load bar),
`write:untyped`, `dyn:receiver`, `es5:proto`; (4) the decisions on DOM, strict-off and E4.

## Crashes and internal errors (A)

| packages | cause | packages |
|---|---|---|
| 8 | SC9001 `assign to undeclared local/global` | chai, colors, dayjs, deepmerge, esbuild, path, rxjs, underscore |
| 3 | SC9001 `assign to immutable local` (Babel's lazy-require `_x = function(){...}` helpers) | babel-jest, jest, regenerator-runtime |
| 2 | SC9001 `ternary must not be void` | mkdirp, rollup-plugin-node-resolve |
| 2 | SC9001 bare `undefined`/`null` unit outside a unionWrap | babel-jest, eslint-plugin-flowtype |
| 1 each | SC9001 `call to undeclared function` (137 sites), `type dyn != return func`, `fromEntries arg expected array, got dyn`, `closure over undeclared function` | chai, rxjs, eslint-plugin-jest, esbuild |
| 2 | analyze() throws `Cannot read properties of undefined` in `lowerStmts` (lower-stmts.js:119) | eslint-plugin-promise, webpack |
| 2 | analyze() throws `lowerer bug: union-typed receiver lowered to a non-union` (lowerUnionProperty) | less, sass |
| 2 | analyze() throws `could not load <entry>` (the entry is not in the program: a `.js` entry the package exports but tsgo does not type-include) | @emotion/react, vue |
| 23 repos, 2 pkgs | SC0004 typescript-go checker panic (`interface conversion`), 10 repos outside the past-gate pass | see tables-repo.md |

Stratum B had no analyze() crashes on entries that passed the gate. 142 of the 7,416 past-gate entries failed,
which is expected on programs that do not type-check, so they are not counted. A one-off probe with
`--dynamic` (not used in the survey) also hit `lowerer bug: views of accessor-carrying records are refused
before the factory` (island-views.js) on rimraf's ESM entry.

## Method

- **List A**: [ecosyste.ms](https://packages.ecosyste.ms) npm packages ordered by `dependent_packages_count`,
  fetched 2026-11-01 (`data/npm-candidates.json`). Walked in rank order until 300 shipped runtime JS: 17
  `@types/*` and 1 type-only package (`fs`) were skipped, and 1 download (`flow-bin`) timed out. 302 were kept
  (two extra from a race). Each has its version, tarball URL, registry integrity, and sha256 in
  `data/npm-packages.jsonl`.
- **List B**: 73 from GitHub's most-starred `language:TypeScript` repos (`data/repo-candidates.json`) plus 33
  TypeScript repos behind the npm candidates (libraries, `data/repo-libs.json`), so the stratum is not all apps.
  Skipped: 100 repos over 400 MB, 4 with more than 3,000 source files, 5 non-code by name, 2 without TS source
  outside tests and docs (`data/repo-list.jsonl` gives each skip a reason). Each kept repo has its commit and
  the sha256 of `git archive HEAD`.
- **Downloads** (`fetch-npm.mjs`, `fetch-repos.mjs`, `lib.mjs`): registry tarballs fetched directly and verified
  against `dist.integrity` (sha512, falling back to sha1), unpacked with `tar` only, symlinks deleted. Clones are
  shallow, with no hooks, submodules or LFS. Nothing was installed, built or run; no package scripts ran.
  Everything lives in `~/.cache/tsinter-dl/survey/`, one directory per tarball and per clone.
  `data/deps.jsonl.gz` lists all 12,279 dependency tarballs with URL and sha256.
- **Dependencies**: each npm package gets its runtime closure (dependencies plus required peers, optional ones
  skipped, capped at 250) laid out Node-style, plus `@types/node@24` and a `tsconfig.json` with
  `skipLibCheck`, as a real project would have. Repos get their `dependencies`/`peerDependencies` and `@types/*`
  dev dependencies (capped at 700); workspace siblings are symlinked.
- **Analysis** (`plan.mjs`, `plan-repo.mjs`, `worker.mjs`, `run.mjs`): `analyze()` from this worktree's
  `packages/compiler/dist`, called in-process with two in-memory load hooks. The repo is not modified:
  1. `analyze()` lowers as the WasmGC lanes do (`undefSlots`, `hostFetch`, `targetPlatform: "host"`). Stock
     `analyze()` lowers for the C/LLVM lanes.
  2. `node:vm` is stubbed so `comptime()` can never evaluate third-party code.

  Each package's runtime file closure is found by parsing every module edge, conditional `require()` included.
  Every file in it is analyzed as its own entry (up to 300 per package, 120 per repo, evenly sampled), so a
  blocker in one file does not hide another file's sites. Each entry opts in only its own package:
  `--npm-static <pkg>`. The first entry also runs the real `compile({backend: "wasm"})` to catch SC3001 (output
  discarded). A package whose own files come back clean is re-analyzed with its whole closure opted in (the
  "with dependencies too" line). B gets a second pass with checker errors ignored for the 75% of entries the
  gate stopped (`repogate`). Its sites are kept apart.
- **Resumable**: one worker process per target, 4 at most. Each finished entry is appended to
  `raw/<stratum>/<id>.jsonl`. Hung entries are killed and recorded (timeouts: 150 s per file, 480 s for the
  first entry), crashes are recorded, and a fresh worker resumes after them.
- **Collation** (`collate.py`, `report.py`, `families.py`, `joint.py`): sites are deduplicated across entries.
  Only the package's own files count (dependency sites are dropped). SC2004-style cascades are dropped too.
  Sites are classified into families and histogrammed. `results/{npm,repo}.jsonl.gz` holds one compact record per
  package: verdict inputs, crash records, and site rows of (kind, code, init level, count, message,
  **anonymized** shape, file indices). It holds no third-party source. `report.py` and `joint.py` rebuild every
  table from those two files alone.

Rerun: `node lists.mjs npm && node lists.mjs repos && node fetch-npm.mjs 300 && node fetch-repos.mjs 100 70 &&
node run.mjs npm && node run.mjs repo && node run.mjs repogate && python3 -I collate.py npm && python3 -I
collate.py repo && python3 -I report.py npm && python3 -I report.py repo && python3 -I joint.py && python3 -I
tidy-deps.py`. Run them from this directory, after `pnpm -r build`.

## Caveats

- **Clean means no refusal was found, not that the program runs the same as Node.** Deferred fences in code
  that is never called are harmless, and silent divergences (round 2's `silent/`) are invisible to this method.
- **Selection bias.** A is ranked by direct dependents, which favors dev tooling (eslint plugins, babel,
  webpack loaders) over runtime libraries. B is ranked by stars, which favors 2026's agent and app repos and
  browser UI. It is also cut at 400 MB, which removed 100 of the largest star repos (more apps, monorepos).
  Neither stratum is a sample of "code someone would compile with tsinter".
- **Families are message-regex buckets** (`families.py`). 16% of A packages and 42% of B repos have at least one
  `other` site. The family boundaries are a judgment call, and `binding:blocked` is mostly knock-on.
- **Masking.** A package-level fallback, a refused class, or a blocked declaration hides the sites behind it, so
  the counts are lower bounds and the greedy is optimistic: fixing a family can reveal the next one. The
  per-file sweep reduces this, but does not remove it.
- **Dependencies distort both strata.** In A, each file opts in only its own package. Values from dependencies
  then come through the import fence and show up as `dep-edge` plus knock-on sites, which are excluded from
  the family counts, so constructs that touch dependency values are undercounted. In B, missing or unbuilt
  dependencies (a workspace sibling's `dist`, generated code, `#imports` maps, dev-only packages) and ambient
  `.d.ts` files outside the import graph stop 75% of entries at the type-check gate. The past-gate pass
  sees past it with degraded types, which inflates `types:shape` (most `SC2011` sites there are any-typed
  values from unresolved imports). Its sites are therefore reported separately and kept out of the main B
  greedy.
- **Sampling.** Repos above 120 source files are sampled evenly; packages above 300 closure files are truncated
  (webpack, 507 files). Each entry has a timeout. Family presence in a big repo is a lower bound.
- **SC3001** is only seen on each package's first entry, the one that is actually compiled.
- **Init level** (unconditional module-level fence) is a syntactic estimate. An IIFE counts as top level; a UMD
  factory passed as an argument does not.
- **QuickJS bound** checks builtin imports only. It does not account for engine gaps, the value bridge, or
  `module:embedded` not existing on the wasm lanes yet.
