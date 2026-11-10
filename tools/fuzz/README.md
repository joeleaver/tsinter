# tools/fuzz — the differential fuzzer

Generates small deterministic TypeScript programs, runs each on Node 24 and
on tsinter's lanes, and looks for **silent divergences**: a program that
compiles and runs but prints something other than Node, with no named
diagnostic. Divergences and crashes are minimized, bucketed, and written up
in a markdown report.

No dependencies beyond the repo's own: the built compiler
(`packages/compiler/dist`), the shared wasm test host
(`packages/compiler/test/wasm-host.ts`, the driver the GH-row unit tests
use) and the root `typescript` devDependency (tsc, the minimizer's AST).

## Usage

```bash
pnpm build                                     # the fuzzer runs the built compiler
node tools/fuzz/fuzz.mjs --count 200           # seeds 1..200 on the wasm lane
node tools/fuzz/fuzz.mjs --seed 5000 --minutes 30 --jobs 8 --lanes wasm,wasm-native --print-report
node tools/fuzz/fuzz.mjs --show 1234           # print the program for seed 1234
```

The report is `<out>/report.md` (default out dir: `$TMPDIR/tsinter-fuzz-<seed>-<pid>`),
next to `results.jsonl` (one line per program) and `buckets.json`.

| flag | default | meaning |
|---|---|---|
| `--seed N` | 1 | first seed; seeds run consecutively |
| `--count N` / `--minutes M` | — | stop after N programs or M minutes (one is required) |
| `--jobs N` | min(4, cores-1) | worker processes (each compiles in-process; ~0.5 GB each) |
| `--lanes` | `wasm` | `wasm`, `wasm-native` (≈4 s more per program: wasm2c + clang), or both |
| `--lang` | `ts` | `ts`, `js` (the TS program through `ts.transpileModule`), or `mix` (every third seed JS) |
| `--areas` | all | comma list of generator areas: `rec,spread,dyn,union,class,closure,error,format` |
| `--batch N` | 50 | programs per tsc batch |
| `--out DIR` | tmp | where programs, results and the report go |
| `--no-minimize` | off | skip minimization |
| `--min-budget N` | 300 | predicate calls per minimized finding |
| `--min-minutes M` | 15 | wall-clock cap on the whole minimization phase |
| `--max-minimize N` | 40 | pre-buckets minimized (the rest are listed unminimized) |
| `--keep` | off | keep every generated program on disk |
| `--print-report` | off | also print the report to stdout (for nico runs) |

One program by hand, on Node and any lanes, with every diagnostic:

```bash
node --experimental-transform-types --import ./tools/fuzz/ts-resolve.mjs tools/fuzz/probe.mjs prog.ts wasm,wasm-native
```

On the shared laptop keep runs light and inside a memory scope:
`systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 node tools/fuzz/fuzz.mjs --count 100 --jobs 3`.
Campaigns go to nico-top: `/home/joe/dev/tsinter-tools/nico.sh "$PWD" -- node tools/fuzz/fuzz.mjs --minutes 40 --jobs 8 --print-report`
(bounded to 30–60 minutes; nico.sh builds first).

## How it works

- **gen.mjs** — a seeded PRNG (`prng.mjs`) drives a generator of 2–6
  *snippets* per program, each from one bug-prone area: records with
  optional fields written/deleted in varying orders, quoted and numeric
  keys; spreads, rest, destructuring defaults; `any` views, `JSON.parse`
  casts, `unknown` narrowing, typeof; unions and discriminated unions;
  classes with `this`, arrows, getters, private fields, subclasses,
  toString; closures and higher-order calls; errors (custom, renamed,
  builtin throws, non-Error throws, cause, finally); number/string
  formatting, inspect layout, JSON.stringify arguments, util.format.
  Snippets reuse earlier snippets' records, so areas interact. Each
  snippet ends in observers, and every printed line carries a label
  `#<snippet>:<observer>`, so the first differing line names what diverged.
  Programs use erasable TS only, end in `export {}` (ESM, strict, like a
  module), never read time or randomness and never let an exception escape.
- **fuzz.mjs** — generates a batch, type-checks it with one `tsc --noEmit`
  under `tsconfig.base.json` (programs tsc rejects are generator noise and
  are skipped), then runs each on the worker pool. When tsinter refuses a
  program (at compile time or by a run-time fence), the refusal's location
  says what to prune: a non-declaring top-level statement (an observer, a
  write) is dropped, otherwise its whole snippet is (still drawn from the
  PRNG, so the rest of the program is unchanged), and the program runs
  again — up to six times. Counts are per program on its final run.
- **exec.mjs / worker.mjs / pool.mjs** — Node runs the program with plain
  type stripping (as the corpus harness's oracle does); each lane compiles
  in-process and runs through the shared test host (wasm) or the native
  binary (wasm-native). Classes: `match`; `refused` (a named compile
  diagnostic, or a fence whose stdout is a prefix of Node's); `divergence`
  (kinds: `stdout`, `stderr`, `throws` = exits with an error where Node
  doesn't, `before-fence` = wrong output and then a fence); `crash` (`ice`
  SC9001, `compiler-throw`, `invalid-module`, `bare-trap`, `host-error`,
  `native-trap`, `timeout`); `invalid` (Node failed, or tsinter's own tsc
  gate, SC0001, rejected what tsc accepted).
- **minimize.mjs** — for each pre-bucket (class, kind, snippet area,
  observer, diff nature) the smallest program is shrunk on the TS AST:
  ddmin over top-level statements, then nested statements, class members,
  literal properties/elements, call arguments, type members, union arms,
  and simplifications (if → branch, try → body, literals → `1`/`"a"`). The
  predicate is "same class and kind, same observer, same *diff nature*"
  (order / missing / extra / value — so a key-order bug cannot shrink into
  a dropped-key bug). Candidates that stop type-checking fail by SC0001.
- **report.mjs / known.mjs** — final buckets merge minimized repros with
  the same signature (class, kind, observer, nature, syntactic features).
  Each lists its repro and Node's vs tsinter's output. `known.mjs` holds
  predicates for findings already registered in SEMANTICS.md or filed on
  GitHub; matching buckets are marked so.

The fuzzer lives outside every workspace package (`pnpm-workspace.yaml`
lists `packages/*`; each package publishes only its own `files`), outside
every tsconfig's `rootDir`, and has no `*.test.ts`, so vitest never picks
it up. `tools/fuzz/check-repo.sh` re-checks that (lint, tsc of compiler and
CLI, vitest's file list, `npm pack --dry-run` of each package, `dist/`).

A divergence is only a bug if SEMANTICS.md doesn't register it: check each
new bucket there (and in open issues) before filing, then add a `known.mjs`
entry for it.
