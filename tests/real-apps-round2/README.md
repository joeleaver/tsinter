# Real-application trial, round 2 (main @ b7808c96, after Unit U)

Not corpus programs. Minimized repros + notes from re-running round 1's apps
(and two new ones) on the `wasm` and `wasm-native` lanes against Node v24.18.1.
Nothing here is wired into a test runner.

## Layout

- `silent/` — **silent divergences** (build clean, exit status as Node, stdout differs). Each file prints
  Node's answer under `node` and a different one under `tsinter build --backend wasm-native` / `--backend wasm`.
- `idioms/` — one repro per refused-idiom family of the work queue below (each refuses, at build time or as a
  deferred runtime fence), plus `90-orphan-cascade-diagnostic.ts` (a diagnostic bug).
- `harness/` — the app drivers (`chess-driver.ts`, `jsdiff-driver.ts`, `semver-driver.cjs`), the patch
  scripts (`chess-variant.py <skip-categories> <dir>` rebuilds chess.js 1.4.0 + round-1 patches minus the named
  categories; `diff-patch.py`, `semver-patch.py`), the lane runner (`lane.py <spec> node|wn|wasm <out>`; the
  wasm lane runs through a copy of `tests/harness/wasm-differential.test.ts` with an argv hook and
  `realprobe-tail.ts.txt` appended), `cmp.py`, the census (`sites.mjs` dumps every reached refusal site via
  `analyze()`; `idioms.py` groups them) and its output `idioms-census.txt`. Paths inside point at the session
  scratchpad; downloads are in `~/.cache/tsinter-dl/apps/<name>/` with `SOURCE.txt` (URL + sha256).

## Apps

| app | shape | Node | wasm | wasm-native | patches still needed |
|---|---|---|---|---|---|
| chess.js 1.4.0 (TS src) | class-heavy TS + peggy-generated JS parser | ref | MATCH 8/9 cases | MATCH 8/9 (+ 4 fuzz-text, 4 fuzz-game, 6 deep-perft workloads all MATCH) | 12 categories, ~70 sites (round 1: 16 categories, ~83); `pgn` case still differs (see silent/01) |
| smol-toml 1.9.1 (TS src) | recursive value types, `extends Date` | ref | refuses (same 25 errors as round 1) | refuses | n/a — no patch set reaches a build |
| papaparse 5.7.0 (UMD JS, `--npm-static`) | ES5 constructor/prototype lib | ref | builds; dies at init (deferred fence `typeof define`) | same | UMD sniff (2) still needed; then ES5 prototypes (89 deferred sites) |
| polka 0.5.2 (+trouter, matchit) | ESM/CJS classes, `.bind` | ref | builds; dies (Polka class blocked) | same | not reachable without rewriting `bind`/override |
| expr-eval 2.0.2 (UMD bundle) | ES5 prototypes | ref | refuses: SC3001 `libCall:dyn.hasKey` (`in` on a dynamic object) | refuses | then 109 deferred sites |
| marked 18.1.2 src + CLI | TS generics, option bags | ref | refuses (40 errors, as round 1) | refuses | n/a |
| marked 18.1.2 npm (minified ESM) | | ref | refuses (5) | refuses | n/a |
| **jsdiff 9.0.0 (new, TS src)** | generic class hierarchy, option-or-callback overloads | ref | refuses (27 root sites) | refuses | 3 patch iterations / 41 sites still leave ~30 errors (intersection option bags, `const ret = []`, `toString(8)`, `splice` 3-arg) |
| **semver 7.8.5 (new, CJS JS)** | function-per-file CommonJS, require cycle | ref | refuses SC1013 (bottom `require` cycle idiom) | same | after hoisting 13 requires (Node-preserving): builds, dies at init on `module.exports = <arrow const>` (39 sites) |

### chess.js: which round-1 patch categories are still needed (each removed alone, rebuilt, re-run)

Still needed (build refuses without it): `bigint` (Zobrist keys; 14 sites), `formulti` (8 —
`for (let i = 0, len = …)`), `sparse` (4 — `new Array<Piece>(128)`, `delete board[sq]`; forces 21 `!`),
`privbracket` (3 — `chess['_moves']` element access on a class), `tsgocrash` (1 — SC0004 typescript-go panic on
`(s.match(re) || []).length`), `throwbang` (1 — `throw new Error(error)` with `string|undefined`), `compound` (12 —
`this._castling.w |= …`, `this._castling[us] ^= …`), `inop` (5 — `square in Ox88`), `untypedarr` (7 — `const
legalMoves = []`), `looseeq` (2), `pgnheaders` (2 — any from `pgn.d.ts`), `pgn_in` (1 — wasm SC3001
`dyn.hasKey`), `pgn_proto` (5 — without it `peg$subclass(peg$SyntaxError, Error)` fences at module init and every
case dies).

No longer needed (Unit U): `typeofargs` (1), `defparam` (1), `recundef` (7 — missing `Record` keys), `popguard`
(4 — `pop()` of an empty history). Exercised by the new `fuzz` workload (comments, undo-to-empty), all MATCH.

## Performance (chess.js, CPU user+sys seconds, median of 3; box loaded, wall clock ignored; raw: harness/perf-raw.txt)

| workload | Node, original src (bigint keys) | Node, patched src (same as compiled) | wasm-native | wn / Node-patched |
|---|---|---|---|---|
| startup (`bogus`, exit 2) | 0.43 | — | 0.00 | — |
| play 1 300 | 0.92 | — | 0.18 | 0.2× (startup-dominated) |
| fuzztext 1 1500 | 0.90 | 0.62 | 0.40 | 0.65× |
| perft 5 (4.87M nodes) | 9.98 | 5.65 | 17.7 | **3.1×** |
| perft 4 kiwipete | 7.38 | — | 14.2 | — |
| fuzz 1 60 (verbose moves, SAN, undo) | 9.76 | 5.23 | 12.8 | **2.4×** |

RSS: wn ~70 MB flat vs Node 95–127 MB. No regression from Unit U: round 1's pre-Unit-U binary vs today's,
interleaved ×5 on perft 5: 18.4 vs 16.3 s median (noise ±3 s). The wasm lane (in-process V8, wall time
only) ran the 100-game fuzz cases 10–15× slower than Node.

## Silent divergences (most important)

1. `silent/01-catchable-runtime-fence.mjs` — **a deferred compile fence is an ordinary catchable Error.** The
   build prints nothing; a `try/catch` in the program swallows the fence and the program exits 0 with
   different output. This is exactly how chess.js's `pgn` command diverges: `loadPgn` reaches pgn.js's
   `options.peg$currPos | 0` (SC2011), the driver's catch prints `error the '|' operator …` per game, exit 0.
   (`tsinter coverage` lists 187 such sites in pgn.js; `build` lists none.)
2. `silent/02-localecompare-code-unit-order.ts` — static `String.prototype.localeCompare` compares code
   units (`"a".localeCompare("B")` is 1; Node/ICU -1), so `names.sort((a,b) => a.localeCompare(b))` orders
   differently. The lowering's comment calls it "a documented divergence (SEMANTICS.md)", but no S### entry
   exists (only the island's S-entry mentions localeCompare).
3. `silent/03-istty-false-not-undefined.ts` — `process.stdout.isTTY` on a pipe prints `false` / typeof
   `boolean`; Node has no such property (`undefined`). The lowering comment calls it documented; no S### entry.
4. `silent/04-regex-nonparticipating-group-S064.ts` — registered (S064), but S064's rationale ("the IR types these
   results `string[]`, which has no representable absent element") no longer holds on the WasmGC lanes after
   Unit U (string slots hold `undefined`). semver-style parsers test `m.groups.pre === undefined`.
5. `silent/05-hole-fence-program-wide-S119.ts` — loud, registered (S119): one past-the-end write anywhere makes
   `.map` on an unrelated hole-free literal throw. Listed because the fence is catchable (same issue as 1).

## Refused-idiom queue (unpatched apps; root sites only, cascades dropped)

See `harness/idioms-census.txt` (generated by `idioms.py`) and `idioms/` for one repro per family. The
census runs `analyze()` on every unpatched app; chess.js's TypeScript sites hide behind its bigint blocker
there, so their counts come from the patch ablation instead (marked †).

| # | idiom family | apps | root sites | repro |
|---|---|---|---|---|
| 1 | writes/updates through nested or untyped receivers: `o.a.b = v`, `o[k] = v` (k any), `o.n++`, and TS compound assignment on member chains `this.a.b \|= v`, `a[i] += v` | 6 (chess, marked-npm, semver, papaparse, marked, jsdiff) | 71 + 12† | idioms/01, 02 |
| 2 | method calls / member reads / switch / for-in / instanceof on any-or-unknown receivers in JS | 7 | 64 | (covered by 01/03) |
| 3 | stdlib members with no lowering: `reverse`, `sort()`, `join()`, `n.toString(radix)`, `toPrecision`, `toExponential`, `splice(i,0,x)`, `split(sep, n)`, `substr`, `flat`, `Object.fromEntries/defineProperty`, `JSON.stringify(v, replacer, n)`, `Set<any>`, dynamic `RegExp`; plus Date values (2 apps / 6) | 7 | 41 | idioms/07 |
| 4 | types with no static representation: option bags (`Fn \| A & B & Partial<C>`), `ErrorOptions & {…}`, any-typed members, recursive `Record<string, unknown>` (TomlTable) | 6 | 36 | idioms/06 |
| 5 | operators on any-typed values in JS (`x \| 0`, `>>>`, `===`, `k-- > 0`, `+=`) | 5 | 42 | idioms/03 |
| 6 | ES5 constructor functions, `X.prototype.m = function`, `Parent.call(this)`, `Object.create`, props on function objects, `fn.bind(this, …)` | 5 | ~119 | idioms/04 |
| 7 | builtin globals / Math / string methods as values (GH #84) | 5 | 11 | (round-1 01) |
| 8 | `in` with a computed key (TS), and `k in obj` on a dynamic object (wasm SC3001 `dyn.hasKey`) | 4 (chess, expr-eval, jsdiff, pgn.js) | 9† | idioms/08, 08b |
| 9 | CommonJS shapes: `module.exports = <const arrow>`, `require` at the bottom (cycle idiom), `exports = module.exports = {}` | 4 (semver 131) | 143 | idioms/05-cjs-shapes |
| 10 | TS `const xs = []` (evolving any[]) typed `number[]` — every later use errors with "expected 'number'" | 2 | 9† (≈35 errors) | idioms/09 |
| 11 | `var` read inside a hoisted function declared above it (every peggy-generated parser) — SC1030, deferred | 2 | 147 | idioms/10 |
| 12 | generic subclass of a generic base / JS method override with rest params | 2 | 3 (+12 cascades) | idioms/11, 11b |
| 13 | UMD `typeof define/module/self/window` sniffing | 2 | 8 | round-1 umd-npm-static |
| 14 | `for (let i = 0, n = xs.length; …)` | 1 | 8† | idioms/13 |
| 15 | bigint | 1 | 14† | — |

Recommended first unit (most apps per unit of work): #1 + #5 + #10 + #14 (all "ordinary" JS/TS statement
shapes), then #3's cheap stdlib members (`reverse`, `sort()`, `join()`, `toString(radix)`, `splice` 3-arg).
