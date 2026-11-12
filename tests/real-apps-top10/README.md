# Real applications, the top 10 (baseline, main @ c68547cd)

Joe's 2026-11-10 priority: make the top 10 Node-runnable TypeScript projects on GitHub run. This directory is
step one: the selection, the setup, and a baseline measurement. **The compiler is unchanged.** It measures
origin/main at `c68547cd`. U2 (maybe-dynamic values) is about to merge; **a re-measure after U2 is planned**,
with the same harness (`harness/run-all.sh`, then `harness/run-census.sh`).

"Running" means: tsinter builds the project from unmodified source (its TS sources, deps as installed), and a
realistic workload matches Node byte for byte (stdout, stderr, exit code).

## Headline

**0 of 10 run.** **0 of 10 build** on the wasm lane: 9 refuse at build with named diagnostics, and one
(openclaw) is an internal error, the compiler running out of memory. Since nothing built, the wasm-native lane
was not run (both lanes share the frontend; round 3 found identical diagnostics on both). No run happened, so
**no silent divergence and no runtime crash was found**. The Node oracle runs every workload, and every
workload matched itself on a second Node run.

The first wall is not the language. **6 of 10 projects stop at module resolution before any lowering**
(deepseek, vue, n8n, shadcn, pi, open-design): their sources import sibling workspace packages whose `exports` name a `dist/` only their build writes, or
alias paths through tsconfig `paths`. Node can't run those sources either. They run under the projects' own
dev runners (tsx, vite-node, vitest), and here under the oracle's loader, which resolves the same way. tsinter
resolves the way plain Node does, so it sees missing modules, then hundreds of knock-on type errors. Only
opencode gets past resolution to real language blockers.

## Per project (wasm lane; `results/summary.tsv`, `results/build/`, `results/cmp/`)

| # | project (stars) | target / workload | Node | build | first blockers |
|---|---|---|---|---|---|
| 2 | rea (449,815) | the `rea` CLI (`src/cli.ts` via `drivers/rea-main.ts`): version, help, `inspect-api-contract` on an OpenAPI and a GraphQL fixture, `inspect-byte-entropy`, two error paths | 8 cases, ok | refuses, 13 | `node:v8` imported by 12 modules (`getHeapStatistics` for memory headroom) (`module:builtin`); one type error against the installed `frida` types |
| 3 | openclaw (394,297) | the `openclaw` CLI (`src/entry.ts`): version, help, `config --help`, `config get`, `completion --shell bash` (260 KB), unknown command | 6 cases, ok | **internal error**: compiler OOM | at Node's default heap the vitest worker died ("Ineffective mark-compacts near heap limit", ~2 GB); with an 11 GB heap the tsgo + compiler process tree passed the 14 GB cap and was OOM-killed |
| 5 | deepseek-harness (278,167) | `apps/cli` (`dsh`): version, help, `--profile web --dump-config-schema`, `web --dump-default-config`, a missing-flag error | 5 cases, ok | refuses, 41 | 28 unresolved `@deepseek-ai/*` workspace packages (exports → unbuilt `lib/`), 9 knock-on |
| 6 | opencode (225,897) | `packages/util` patch engine + `packages/patchmark` markdown stream (`drivers/opencode-main.ts`) | 4 cases, ok | refuses, 35 | `WeakMap` (12, `stdlib:js`), `effect` not compiled statically under `--npm-static auto` (7, `dep-edge`), union field reads (3, `types:shape`), `Map<string, Set<number>>`, a union with a `Map` arm, dynamic keyed read/write, a generic method declared in a dependency (`Result.isFailure`) |
| 7 | vue (212,622) | Vue 2.7 template compiler + SSR (`drivers/vue-main.ts`) | 3 cases, ok | refuses, 205 | 162 unresolved tsconfig-`paths` aliases (`core/`, `shared/`, `web/`, ...), 19 DOM type names (tsconfig `lib: ["dom"]` not adopted), 18 `__DEV__` (`src/global.d.ts`, included by tsconfig, not loaded) |
| 8 | n8n (210,019) | `packages/workflow` (`drivers/n8n-main.ts`): graph queries, node parameters, expressions | 3 cases, ok | refuses, 178 | 61 unresolved `@n8n/*` workspace packages (exports → unbuilt `dist/`), 108 knock-on |
| 16 | shadcn (127,845) | `packages/shadcn` CLI on the repo's own `apps/v4`: version, help, `info --json`, `build` of a 4-item registry (output files compared), a missing-file error | 5 cases, ok | refuses, 41 | 38 unresolved: `@/src/...` tsconfig paths and `@shadcn/registry` (workspace, unbuilt); `import packageJson from "../package.json"` without `with { type: "json" }` (plain Node refuses it too; SC1010 says so) |
| 18 | pi (121,245) | `packages/agent` agent loop against a scripted model (`drivers/pi-main.ts`): 3-turn tool loop, schema-invalid tool args, follow-up queue | 3 cases, ok | refuses, 30 | 6 unresolved `@earendil-works/pi-ai`/`pi-schema` (workspace, unbuilt), 14 knock-on |
| 22 | paperclip (112,925) | the `paperclipai` CLI (`cli/src/index.ts`): version, help, `env`, `issue --help`, unknown command | 5 cases, ok | refuses, 9 | `node:sqlite` (4), `node:readline`, `node:process` (`module:builtin`); `BodyInit`/`HeadersInit` fetch types not found |
| 24 | open-design (107,031) | `apps/daemon` (`od`): help, `tools directions` (text, JSON, one id, a bad id), an unknown option | 6 cases, ok | refuses, 975 | 637 unresolved `@open-design/*` workspace packages (exports → unbuilt `dist/`), 319 knock-on, one `node:v8` |

Driver sites (the trial's own drivers) are kept apart in the census. They add `generic:fn` and `dyn:receiver`
for opencode's driver and knock-on errors in pi's; none is a first blocker on its own.

## Blocker census (at the type-check gate; `results/blockers-census.txt`)

Root sites from `analyze()` lowered as the WasmGC lanes lower, classified with round 3's
`survey/families.py`, cascades dropped, driver sites excluded. openclaw has no census (its analysis outgrows
the cap as its build does).

| # | family | projects blocked | root sites |
|---|---|---|---|
| 1 | `tsc:missing-dep`: unresolved import. Here **not** a survey artifact: workspace packages whose exports name unbuilt output (deepseek, n8n, pi, open-design, shadcn), tsconfig `paths` (vue, shadcn); rea's one is a type mismatch against installed `frida` types | 7: open-design 637, vue 162, n8n 61, deepseek 28, shadcn 8, pi 6, rea 1 | 903 |
| 2 | `tsc:knock-on`: type errors downstream of those imports | 6: open-design 319, n8n 108, pi 14, deepseek 9, vue 6, shadcn 2 | 458 |
| 3 | `tsc:dom`: browser/fetch type names (tsconfig `lib` is not adopted, so names the project's own lib and types settings provide are missing; paperclip's are `BodyInit`/`HeadersInit`) | 3: vue 19, paperclip 3, n8n 1 | 23 |
| 4 | `module:builtin`: `node:v8`, `node:sqlite`, `node:readline`, `node:process` | 3: rea 12, paperclip 6, open-design 1 | 19 |
| 5 | `tsc:ambient`: `__DEV__` from a tsconfig-included `global.d.ts` | 1: vue | 18 |
| 6 | `stdlib:js` (`WeakMap`) | 1: opencode | 12 |
| 7 | `dep-edge` (`effect` not static under `--npm-static auto`) | 1: opencode | 7 |
| 8 | `types:shape`, `dyn:receiver`, `write:untyped` | 1: opencode | 3, 1, 1 |
| - | internal error: compiler out of memory | 1: openclaw | - |

## Behind the gate (`results/blockers-census-past-gate.txt`)

The same census with the survey's "repogate" hook: checker errors no longer stop `analyze()`, so the sites
behind a type error are lowered and listed (types are degraded there, so read these as a direction, not exact
counts). Only rea gets much further: its gate was 13 `node:v8` imports and one type error, so its whole
module graph lowers, and it shows what a large TypeScript CLI needs once the import wall is down. The other
eight stay mostly behind unresolved workspace imports, because the files those imports name are never loaded.

| family | projects | root sites | notes |
|---|---|---|---|
| `types:shape` | 7 | 6,663 (rea 6,421) | unions with `Set`/`Map` arms, option bags, `any` members |
| `dep-edge` | 7 | 5,009 (rea 4,779) | dependencies `--npm-static auto` does not compile: `zod` (rea 4,022, paperclip 31), `@babel/types` 443, `incur` 164, `commander` (paperclip 68, shadcn 4, deepseek 1), `effect` 9. n8n's are attributed to `@types/luxon` (27) and `@types/lodash` (12), the types-only packages, not `luxon`/`lodash`: worth a look |
| `tsc:missing-dep` / `tsc:knock-on` | 7 / 6 | 903 / 458 | unchanged: the resolution wall |
| `stdlib:js` | 6 | 675 (rea 612) | |
| `dyn:receiver` | 6 | 455 (rea 439) | |
| `stdlib:node` | 3 | 446 (rea 415) | |
| `generic:fn` | 1 | 1,812 (rea) | generic methods called through receivers |
| `bigint` | 1 | 411 (rea) | |
| `date` | 2 | 167 | |
| `types:narrow` | 2 | 149 | |
| `error:shape` | 2 | 86 | |
| `tsgo:panic` | 1 | 10 (rea) | SC0004, an upstream typescript-go checker panic ("interface conversion"), in `src/domain/analysisView/environmentState*.ts` and `domain/desktop/aptRepositories.ts`. Loud, not silent, but a crash in the checker |
| 25 more families | ≤5 each | | `binding:blocked`, `write:untyped`, `es5:proto` (n8n 22), `spread`, `generator`, `fn:call-bind`, `cjs:require` ... |

## Silent divergences and crashes

None: nothing built, so nothing ran. The one internal error is openclaw's out-of-memory build (above). It is
not minimized here; the measurement it needs is the compiler's peak memory against module count, and the
re-measure should record it.

## Recommended order of compiler units

1. **Source-mode resolution** (unblocks the gate for 6 of 10: deepseek, n8n, pi, open-design, shadcn, vue).
   Resolve a workspace package whose `exports` target missing build output to its source, and adopt tsconfig
   `paths`/`baseUrl`, the way the oracle's loader (and tsx/vite-node) does; with it, adopt the project's
   `lib` (DOM and fetch type names) and load the `.d.ts` files its tsconfig includes (vue's `__DEV__`). This
   is a decision for Joe before it is a unit: plain Node cannot run these sources, so "Node is the oracle"
   here means Node under the project's dev runner, and the rule needs an `S###` entry saying so.
2. **Builtin-module imports fence at use, not at import** (rea, paperclip, open-design). `node:v8` and
   `node:sqlite` are imported at module top level by code the workloads never call. Refusing at the import
   blocks the whole build; a deferred fence at the first call keeps the refusal loud and lets the rest
   build. (`node:readline`/`node:process` in paperclip are pending surface, not out of scope.)
3. **Compiler memory on large graphs** (openclaw). It needs more than Node's default heap for the vitest
   worker and more than 14 GB with tsgo alongside. Measure peak memory against module count first.
4. **Common dependencies compiled statically** (`dep-edge`, 7 projects past the gate): make `zod`, `commander`,
   `effect`, `@babel/types`, `@clack/prompts`, `picocolors` eligible for `--npm-static auto` (or say by name
   why not), and check why n8n's imports are attributed to `@types/luxon`/`@types/lodash`.
5. **The rea layer** (what a large CLI needs once its imports resolve): `types:shape` (unions with
   `Set`/`Map` arms, option bags), `generic:fn` through receivers, `stdlib:js`/`stdlib:node`, `bigint`;
   opencode's set overlaps it (`WeakMap`, `Map` values of `Set`, unions with `Map` arms, dynamic keyed
   reads/writes, generic methods declared in a dependency).
6. Then re-measure, after U2 (about to merge) and after unit 1. Every project's real second layer is hidden
   behind the resolution wall until then; the past-gate census only shows rea's.

## Selection

GitHub's TypeScript list by stars (`language:TypeScript stars:>3000 fork:false archived:false`, sorted by
stars), re-fetched read-only with `gh api` on 2026-11-10 (`data/candidates-2026-11-10.json`, 200 repos; the
survey's 2026-11-02 copy has the same order through rank 24). Walked in rank order, taking the first 10 that
run on Node without a browser. The walk with every verdict and reason is `data/selection.json`.

**Picked** (rank, repo, stars on 2026-11-10, target):

| rank | repo | stars | target package |
|---|---|---|---|
| 2 | morluto/rea | 449,815 | the `rea` CLI (root, `src/cli.ts`) |
| 3 | openclaw/openclaw | 394,297 | the `openclaw` CLI (root, `src/entry.ts`) |
| 5 | deepseek-ai/deepseek-harness | 278,167 | `apps/cli` (`dsh`) |
| 6 | anomalyco/opencode | 225,897 | `packages/util` + `packages/patchmark` |
| 7 | vuejs/vue | 212,622 | Vue 2.7 compiler + server renderer |
| 8 | n8n-io/n8n | 210,019 | `packages/workflow` (n8n-workflow) |
| 16 | shadcn-ui/ui | 127,845 | `packages/shadcn` (the CLI) |
| 18 | earendil-works/pi | 121,245 | `packages/agent` (pi-agent-core) |
| 22 | paperclipai/paperclip | 112,925 | `cli` (`paperclipai`) |
| 24 | nexu-io/open-design | 107,031 | `apps/daemon` (`od`) |

**Skipped**:

| rank | repo | reason |
|---|---|---|
| 1 | freeCodeCamp/freeCodeCamp | browser front-end plus curriculum content; its one Node service (`api/`) is a MongoDB-backed server that cannot start without the database |
| 4 | nilbuild/developer-roadmap | content site (roadmaps, guides), an Astro/React front-end |
| 9 | firecrawl/firecrawl | the Node part is a scraping API server that needs Redis, Postgres and a Playwright service to start; the JS SDK is a network client with no offline function |
| 10 | microsoft/vscode | Electron/browser editor; its CLI is Rust |
| 11 | anthropics/claude-code | plugins, examples and docs; the CLI's source is not in the repo |
| 12 | iptv-org/iptv | content (playlists); its scripts only regenerate that content |
| 13 | yangshun/tech-interview-handbook | content/docs site |
| 14 | garrytan/gstack | Bun-only (`engines: bun`, Bun-compiled tools); the product is Claude Code skills plus a Playwright browser daemon |
| 15 | excalidraw/excalidraw | browser front-end |
| 17 | stablyai/orca | Electron app; its CLI is a client of the running desktop app |
| 19 | immich-app/immich | server needs Postgres and Redis; the CLI is its client; the rest is web and mobile front-ends |
| 20 | thedotmack/claude-mem | its worker and storage need Bun (`bun:sqlite`) |
| 21 | supabase/supabase | Studio (a Next.js front-end) and docs; the platform's services live in other repos |
| 23 | google-gemini/gemini-cli | picked, fetched, then dropped: every Node package imports `packages/core/src/generated/git-commit.js`, which only its build writes |

Judgment calls, for Joe to overrule:

- **Vue** counts. It is a UI framework, but not a component library, and its template compiler and server
  renderer are Node programs. (Angular, rank 25, would count by the same rule; it was not reached.)
- **Separable packages.** Where the product's own entry cannot run from unmodified source, the target is the
  separable Node package under it: opencode (its CLI needs Bun or its vite build for Solid JSX and `.txt`
  imports), pi (its CLI needs model data that only a network generate step writes), n8n (the server needs a
  native database driver whose build is an install script). Each workload drives that package's main API.
- **gemini-cli** (rank 23) was picked, fetched, and then dropped: every one of its Node packages imports
  `packages/core/src/generated/git-commit.js`, which only its build writes. No part runs from unmodified source.
- **Node version.** rea declares `engines.node ^24.22.1` with `engine-strict=true`. The oracle stays Node
  v24.18.1 (tsinter's oracle), so its install overrides the engine check (`projects.json` `installFlags`). Its
  workload runs `src/cli.ts` through a driver, which skips the bin's runtime-admission check. openclaw prints a
  "below the recommended security patch level" warning on stderr; that is part of its expected output.

## Workloads (all deterministic: each was run twice under Node and matched itself, `determinism.txt`)

The case lists are `harness/workloads.json`; the drivers are `drivers/`. CLIs run their real entry on offline
commands and real input (rea on two API-contract fixtures, shadcn on the repo's own `apps/v4` project);
libraries run a driver over their main API. No case touches the network or prints a clock reading (pi's
driver drops `timestamp`/`durationMs` and uses a fake clock; openclaw's `completion` and the rest print
nothing time-dependent). Every case also includes at least one error path where the CLI has one.

- **vue**: `drivers/vue-globals.ts` supplies the build-time defines (`__DEV__` as the CommonJS build computes
  it, `__TEST__`, `__GLOBAL__`, and the `NEW_SLOT_SYNTAX` feature flag) that rollup replaces, because the
  trial runs unbuilt source. Vue's dev-mode compiler validates expressions with `new Function` and its SSR
  render functions use `with`; the workload exercises both, which is what Vue does.
- **n8n**: a stub node type registry like n8n's own tests use, a 7-node graph, `getNodeParameters` with
  display options, and 18 expressions on the default (legacy, tournament) engine.
- **pi**: a scripted model behind pi's `streamFn` seam streams text and tool calls through the real agent
  loop (parallel tools, a tool error, schema-invalid arguments, an unknown tool, a follow-up queue).
- **commander** (not one of the 10; the dependency paperclip, rea, deepseek and shadcn share, SEMANTICS.md
  S133): `drivers/commander-main.ts`, a CLI written in paperclip's commander style, runs inside paperclip's
  tree (`"srcProject": "paperclip"`) against the commander paperclip installed (15.0.0), with
  `--npm-static commander`: help, version, subcommand help, unknown commands and options, missing required
  options and arguments, choices and conflicts errors, a hook, and normal actions.
- **opencode**: apply_patch envelopes parsed and applied (with a BOM, a move, add/delete hunks, five
  parser errors) and a markdown reply streamed in 17-character chunks, then rendered to HTML.

## How the oracle runs unmodified TypeScript source (`harness/node-src-loader.mjs`)

Real TS projects are not written for Node's type stripping. They import `./x.js` meaning `./x.ts`, use
`.tsx`, decorators, enums and parameter properties, point workspace packages at a `dist/` that only their
build creates, and alias paths through tsconfig `paths`. The loader (a `module.registerHooks` hook, loaded
with `--import`) does what the projects' own dev runners (tsx, vite-node, vitest) do and nothing else:

- Node's own resolution first; it wins whenever it succeeds.
- For project files (outside node_modules): `./x.js` → `./x.ts`/`.tsx`, extensionless and directory imports,
  tsconfig `paths` (extends chains followed), and moduleResolution `bundler`'s extension probing for deep
  imports (`lodash/merge`).
- A workspace package whose `exports` name a missing `dist|lib|out|build/...` file resolves to its `src/`
  twin.
- Project `.ts/.tsx/.mts/.cts` files are transpiled with TypeScript 5.9.3 (tsinter's own copy, not the
  project's), honoring the nearest tsconfig's jsx, decorator, class-field and target options. Vue needs
  full-program emit (`?full=1`, one LanguageService per tsconfig) because it re-exports types without
  `export type`.
- An ES module that calls `require()` gets a `createRequire` binding (rollup's commonjs plugin does this for
  Vue), and a JSON import without `with { type: "json" }` loads as JSON (resolveJsonModule + a bundler).

tsinter gets none of this: it compiles the same entry with its own resolver. That gap is the top blocker below.

## Safety (Joe's rules, followed as written)

- Third-party code was downloaded and run only on nico-top, as the `tsinter` WSL user: installs and the full
  runs through `nico.sh` (14G cap, heavy lock); short exploratory Node runs over ssh inside the same cap
  (`systemd-run --user --scope -p MemoryMax=14G -p MemorySwapMax=0`, `prlimit --core=1`, nice 10). The laptop
  only read files and ran read-only `gh api` calls.
- Sources: codeload tarballs of the pinned commit (`harness/projects.json`), cached under
  `~tsinter/.cache/tsinter-dl/top10/dl/`. Every download's sha256 is in `results/downloads.txt` (bun 1.4.4,
  needed for opencode's `bun.lock`, was checked against its release `SHASUMS256.txt`).
- Dependencies: `npm ci --ignore-scripts`, `pnpm install --frozen-lockfile --ignore-scripts` (corepack, the
  project's pinned pnpm), `bun install --frozen-lockfile --ignore-scripts`. All three verify every package
  against the lockfile's integrity hashes. **No project build, install or lifecycle script was run.** The
  runs need no network (the paperclip `channels` command fetched release data and was dropped).
- Project code was treated as data. Nothing third-party is in this repo: only the harness, the drivers, two
  small text fixtures, the lists, and the results.

## Layout

- `data/`: the candidate list and the selection walk.
- `harness/` (paths in `common.py`; work dir `~/.cache/tsinter-dl/top10/` on nico-top):
  - `peek.py`: the read-only `gh api` look used for the selection.
  - `projects.json`: the 10 picks (repo, pinned sha, install command) plus gemini-cli, dropped after fetch.
  - `fetch.py`: download, sha256, extract, install with scripts off.
  - `workloads.json`: per project the entry, cwd, drivers and cases.
  - `node-src-loader.mjs`: the oracle's source loader (above).
  - `lane.py`: round 3's lane runner, adapted. `node`/`node2` run the oracle, `wasm` compiles in-process
    through a copy of `tests/harness/wasm-differential.test.ts` (argv hook) plus `realprobe-tail.ts.txt`
    (round 3's tail, plus a fixed environment and `build.json`), `wn` runs `tsinter build --backend
    wasm-native`. Every lane gets the same environment and a fresh HOME. `SURVEY_HEAP_MB` raises the
    compiler's JS heap.
  - `run-all.sh`: node, node2, wasm, then wn when the wasm build succeeded; `cmp.py` gives each case MATCH /
    REFUSED / CRASH / SILENT.
  - `rerun-openclaw.sh`: openclaw's build again with an 11 GB heap (see results).
  - `sites.mjs` (round 3's, plus npmStatic `auto` and a past-the-gate mode) and `blockers.py` (round 3's,
    over `workloads.json`): the census, classified with `../real-apps-round3/survey/families.py`.
    `run-census.sh` runs it at the gate and past it, then `collect.py` copies the small result files here.
- `drivers/`: the workload drivers and fixtures (copied into the project tree at run time, under `.top10/`).
- `results/`: `summary.tsv`, `downloads.txt`, `build/<p>.wasm.log` (every diagnostic), `build/<p>.codes.txt`,
  `cmp/<p>.txt`, `node/<p>.txt` (the oracle's exit codes and output hashes), `blockers-census.txt`,
  `blockers-census-past-gate.txt`.

Re-run: `nico.sh <worktree> -- python3 -I tests/real-apps-top10/harness/fetch.py`, then
`nico.sh <worktree> -- bash tests/real-apps-top10/harness/run-all.sh`, then
`SURVEY_HEAP_MB=11000 nico.sh <worktree> -- bash tests/real-apps-top10/harness/run-census.sh`.

## Re-measure after U2 (main @ 7aff51dd), 2026-11-11

[`results/u2-7aff51dd/`](results/u2-7aff51dd/): `summary.tsv`, `build/<p>.wasm.log`, `build/<p>.codes.txt`, and `cmp/<p>.txt`.
`run-all.sh` ran with `LANES="node wasm wn"` under an isolated `HOME` on nico-top, so it could not collide
with R1's runs, which write the same `res/` directory. The census was queued and stopped before it ran: **not
measured**. The coordinator stopped it because main had moved on (R1 and R2 merged).

- **0 of 10 build, unchanged.** All nine measured projects refuse with exactly the baseline diagnostics, the
  same codes, counts and messages. U2 changes nothing at the gate. rea is still 12× SC1010 `node:v8` plus
  one SC0001 against `frida`, so U2 cannot show there until R2 (builtins refused at use) lets rea's build past
  the import fences.
- **openclaw: not measured.** The compile was OOM-killed at nico.sh's 14G cap with an 11 GB heap, the same as
  the baseline.
- The past-gate census, the only place where U2 could show for rea, was not run. Its `sites.mjs` hook also
  lacks `sharedDynamic` (see the survey README's U2 section), so it would have needed the patched hook anyway.
