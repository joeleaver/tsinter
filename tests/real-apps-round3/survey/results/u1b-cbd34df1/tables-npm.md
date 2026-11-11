# Stratum A, npm tarballs

Packages: 302. clean: 1, deferred-only: 38, blocked: 34, dep-unavailable: 0, no-result: 229.

Partial analysis (at least one entry timed out or crashed): 1. Timed-out entries: 1. Analyzer crashes: 0. Process crashes: 0. Entries skipped on the time budget: 38.

Of the clean packages, 1 are shims under 20 statements.

Clean with dependencies too: 1 of 1 clean packages stay clean once their closure is compiled.

Verdict breakdown by hard refusal (a build-time diagnostic or package-level fallback, not a deferred fence), top families:

| family | blocked packages |
|---|---|
| other: uncategorized | 23 |
| bundler:interop: bundler output: createRequire banners (node:module), __toESM interop helpers | 7 |
| module:builtin: Node builtin module with no support (SC1010, node:* import fences) | 7 |
| write:untyped: writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member | 5 |
| types:shape: types with no static representation: unions with fields, intersections, recursive records, | 5 |
| module:form: module forms: require() of JSON, default/namespace import forms, re-exports from packages, | 5 |
| date: Date values | 2 |
| generic:class: generic class hierarchies | 1 |
| error:shape: Error specifics: constructor options (cause), overriding Error methods, non-Error throws r | 1 |
| class:dyn: class objects used dynamically: statics via a class value, extending builtins as values | 1 |

## Ranked families (packages affected)

Hard = packages with at least one build-time refusal or package-level fallback in the family. Reached = deferred fences on the entry path. Init = packages with an unconditional module-level site, which dies at load.

| # | family | packages | hard | init | past-gate only | sites | sites/pkg (median) |
|---|---|---|---|---|---|---|---|
| 1 | `dyn:receiver` method calls, member reads, for-in, switch, spread on any/unknown receivers | 55 | 1 | 13 | 0 | 3476 | 7 |
| 2 | `stdlib:js` ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Object.assign, new Set( | 55 | 1 | 35 | 0 | 1890 | 8 |
| 3 | `binding:blocked` reference to a binding whose declaration was refused or has no lowering (mostly knock-on sites) | 52 | 1 | 37 | 0 | 1676 | 10 |
| 4 | `write:untyped` writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member chains | 48 | 5 | 26 | 0 | 2652 | 7 |
| 5 | `cjs:require` require() off top level, computed, or as a value; createRequire; import.meta | 47 | 0 | 34 | 0 | 711 | 4 |
| 6 | `cjs:shape` CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attached before reassign, table ent | 46 | 0 | 36 | 0 | 994 | 2 |
| 7 | `dep-edge` import of an npm package that is not compiled statically | 41 | 16 | 30 | 0 | 929 | 6 |
| 8 | `types:shape` types with no static representation: unions with fields, intersections, recursive records, any-typed members | 39 | 5 | 16 | 0 | 1092 | 3 |
| 9 | `other` uncategorized | 38 | 23 | 26 | 0 | 2950 | 6 |
| 10 | `es5:proto` ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Object.create, setPrototypeOf, p | 38 | 0 | 27 | 0 | 2050 | 9 |
| 11 | `fn:call-bind` Function.prototype.call/apply/bind and `arguments` on compiled functions | 37 | 0 | 5 | 0 | 646 | 3 |
| 12 | `destructure` destructuring beyond typed record sources: absent fields, optional patterns, rest over dynamic values, catch b | 33 | 0 | 14 | 0 | 524 | 4 |
| 13 | `stdlib:node` Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 33 | 0 | 22 | 0 | 348 | 3 |
| 14 | `obj:computed` runtime-keyed (computed-key) object literals holding methods, spreads, or non-scalar values | 29 | 0 | 9 | 0 | 1102 | 3 |
| 15 | `builtin:value` builtin globals, Math or string methods as values (#84) | 28 | 0 | 11 | 0 | 1214 | 4 |
| 16 | `module:ns` module namespace objects as values; library functions as values | 28 | 0 | 18 | 0 | 1162 | 4 |
| 17 | `date` Date values | 28 | 2 | 12 | 0 | 589 | 4 |
| 18 | `fn:value` functions as values: optional/defaulted params, overloads, generics kept open | 28 | 0 | 14 | 0 | 435 | 3 |
| 19 | `op:any` operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, truthiness coercions | 25 | 0 | 2 | 0 | 2347 | 6 |
| 20 | `symbol` symbol-keyed access outside class fields | 18 | 0 | 3 | 0 | 161 | 5 |
| 21 | `var:hoist` `var` read inside a hoisted function declared above it (generated parsers, bundles) | 17 | 0 | 2 | 0 | 2772 | 3 |
| 22 | `global:sniff` reads or typeof of undeclared globals (UMD define/module/self/window, build flags like ngDevMode, devtools hoo | 17 | 0 | 7 | 0 | 142 | 2 |
| 23 | `class:dyn` class objects used dynamically: statics via a class value, extending builtins as values | 15 | 1 | 12 | 0 | 291 | 3 |
| 24 | `generic:fn` generic methods and arrows in forms with no monomorphized home | 10 | 0 | 7 | 0 | 115 | 2 |
| 25 | `error:shape` Error specifics: constructor options (cause), overriding Error methods, non-Error throws read as Error | 10 | 1 | 1 | 0 | 65 | 3 |
| 26 | `in:computed` `in` / hasOwnProperty with computed keys, dyn.hasKey | 10 | 0 | 0 | 0 | 24 | 1 |
| 27 | `module:builtin` Node builtin module with no support (SC1010, node:* import fences) | 10 | 7 | 8 | 0 | 16 | 1 |
| 28 | `closure:capture` bindings captured through a plain nested function with no static storage | 8 | 0 | 0 | 0 | 292 | 2 |
| 29 | `expr:assign` assignments and side effects in expression position (x op= e as a value, void effectful, comma forms) | 7 | 1 | 1 | 0 | 359 | 8 |
| 30 | `bundler:interop` bundler output: createRequire banners (node:module), __toESM interop helpers | 7 | 7 | 7 | 0 | 267 | 1 |
| 31 | `container:elem` Map/Set/array element types outside the supported kinds | 7 | 0 | 5 | 0 | 35 | 1 |
| 32 | `spread` spreads beyond same-shape arrays and one-property conditional object spreads | 7 | 0 | 0 | 0 | 13 | 2 |
| 33 | `export:mutable` exporting a mutable binding by reference (live bindings) | 6 | 0 | 6 | 0 | 45 | 2 |
| 34 | `bigint` bigint | 6 | 0 | 2 | 0 | 43 | 3 |
| 35 | `call:arity` calls omitting required parameters, optional-chaining on unusual values, delete | 5 | 0 | 2 | 0 | 92 | 2 |
| 36 | `for:multi` multi-declarator `for (let i = 0, n = ...)` | 5 | 0 | 0 | 0 | 41 | 9 |
| 37 | `module:form` module forms: require() of JSON, default/namespace import forms, re-exports from packages, export = / import = | 5 | 5 | 5 | 0 | 5 | 1 |
| 38 | `class:local` classes declared inside functions, class expressions, mixins | 3 | 0 | 1 | 0 | 225 | 8 |
| 39 | `generator` async generators, generator methods, for-await beyond streams, .next(value) | 3 | 1 | 1 | 0 | 27 | 11 |
| 40 | `ts-emit:enum` compiled TypeScript enums in shipped JS: E[E["A"] = 0] = "A" | 2 | 0 | 2 | 0 | 15 | 12 |
| 41 | `tsgo:panic` typescript-go checker panic (SC0004) | 2 | 0 | 0 | 0 | 2 | 1 |
| 42 | `generic:class` generic class hierarchies | 1 | 1 | 1 | 0 | 6 | 6 |
| 43 | `types:narrow` narrowing forms: hand-written type predicates, ?? that changes the result type, tuple/string index shapes | 1 | 0 | 0 | 0 | 6 | 6 |
| 44 | `module:cycle` import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 1 | 1 | 1 | 0 | 2 | 2 |
| 45 | `module:default` default exports and default imports (SC1012) | 1 | 1 | 1 | 0 | 1 | 1 |

## Greedy unlock order

Population: 72 packages with a complete analysis (230 partial or empty results are left out; they cannot be called clean). A package counts as clean once every family it has is fixed. Each step takes the family that cleans the most packages; when none can finish a package, the one with the most leverage. `tsc:missing-dep` is the survey environment, so it is treated as already fixed; packages whose every entry stopped at preflight are left out, because nothing past the type check was seen.

### Every family, deferred fences included

Population with at least one entry past preflight: 72. Clean at the start: 1.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 2 | 3 | 4% | 45 |
| 2 | `dyn:receiver` | 1 | 4 | 6% | 54 |
| 3 | `cjs:require` | 3 | 7 | 10% | 46 |
| 4 | `destructure` | 1 | 8 | 11% | 32 |
| 5 | `write:untyped` | 1 | 9 | 12% | 47 |
| 6 | `global:sniff` | 1 | 10 | 14% | 16 |
| 7 | `stdlib:js` | 1 | 11 | 15% | 54 |
| 8 | `other` | 1 | 12 | 17% | 37 |
| 9 | `types:shape` | 2 | 14 | 19% | 38 |
| 10 | `fn:call-bind` | 1 | 15 | 21% | 36 |
| 11 | `fn:value` | 2 | 17 | 24% | 27 |
| 12 | `obj:computed` | 2 | 19 | 26% | 28 |
| 13 | `op:any` | 1 | 20 | 28% | 24 |
| 14 | `var:hoist` | 1 | 21 | 29% | 17 |
| 15 | `class:dyn` | 1 | 22 | 31% | 14 |
| 16 | `closure:capture` | 1 | 23 | 32% | 8 |
| 17 | `es5:proto` | 0 | 23 | 32% | 37 |
| 18 | `stdlib:node` | 2 | 25 | 35% | 32 |
| 19 | `module:ns` | 3 | 28 | 39% | 27 |
| 20 | `builtin:value` | 2 | 30 | 42% | 27 |
| 21 | `date` | 4 | 34 | 47% | 27 |
| 22 | `module:builtin` | 3 | 37 | 51% | 9 |
| 23 | `generic:fn` | 2 | 39 | 54% | 9 |
| 24 | `error:shape` | 3 | 42 | 58% | 9 |
| 25 | `symbol` | 2 | 44 | 61% | 17 |
| 26 | `export:mutable` | 3 | 47 | 65% | 6 |
| 27 | `bundler:interop` | 2 | 49 | 68% | 7 |
| 28 | `spread` | 2 | 51 | 71% | 6 |
| 29 | `in:computed` | 1 | 52 | 72% | 10 |
| 30 | `call:arity` | 3 | 55 | 76% | 5 |
| 31 | `expr:assign` | 1 | 56 | 78% | 7 |
| 32 | `container:elem` | 2 | 58 | 81% | 6 |
| 33 | `module:form` | 3 | 61 | 85% | 4 |
| 34 | `bigint` | 2 | 63 | 88% | 5 |
| 35 | `for:multi` | 1 | 64 | 89% | 4 |
| 36 | `generator` | 1 | 65 | 90% | 3 |
| 37 | `class:local` | 2 | 67 | 93% | 3 |
| 38 | `ts-emit:enum` | 1 | 68 | 94% | 2 |
| 39 | `types:narrow` | 1 | 69 | 96% | 1 |
| 40 | `tsgo:panic` | 1 | 70 | 97% | 1 |
| 41 | `module:default` | 1 | 71 | 99% | 1 |
| 42 | `module:cycle` | 1 | 72 | 100% | 1 |

### Build-time refusals only (the build passes; deferred fences remain)

Population with at least one entry past preflight: 72. Clean at the start: 39.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `other` | 14 | 53 | 74% | 22 |
| 2 | `types:shape` | 3 | 56 | 78% | 5 |
| 3 | `bundler:interop` | 4 | 60 | 83% | 7 |
| 4 | `module:form` | 3 | 63 | 88% | 4 |
| 5 | `module:builtin` | 3 | 66 | 92% | 6 |
| 6 | `write:untyped` | 2 | 68 | 94% | 4 |
| 7 | `module:cycle` | 1 | 69 | 96% | 1 |
| 8 | `stdlib:js` | 0 | 69 | 96% | 1 |
| 9 | `expr:assign` | 1 | 70 | 97% | 1 |
| 10 | `module:default` | 0 | 70 | 97% | 1 |
| 11 | `generator` | 0 | 70 | 97% | 1 |
| 12 | `dyn:receiver` | 1 | 71 | 99% | 1 |
| 13 | `error:shape` | 0 | 71 | 99% | 1 |
| 14 | `date` | 0 | 71 | 99% | 1 |
| 15 | `class:dyn` | 1 | 72 | 100% | 1 |

### Loads: no build-time refusal and no unconditional module-level fence

Population with at least one entry past preflight: 72. Clean at the start: 2.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 2 | 4 | 6% | 35 |
| 2 | `cjs:require` | 4 | 8 | 11% | 33 |
| 3 | `stdlib:js` | 3 | 11 | 15% | 34 |
| 4 | `other` | 3 | 14 | 19% | 25 |
| 5 | `types:shape` | 3 | 17 | 24% | 15 |
| 6 | `module:ns` | 2 | 19 | 26% | 17 |
| 7 | `es5:proto` | 2 | 21 | 29% | 26 |
| 8 | `stdlib:node` | 2 | 23 | 32% | 21 |
| 9 | `write:untyped` | 2 | 25 | 35% | 25 |
| 10 | `destructure` | 3 | 28 | 39% | 14 |
| 11 | `global:sniff` | 4 | 32 | 44% | 6 |
| 12 | `fn:value` | 3 | 35 | 49% | 14 |
| 13 | `builtin:value` | 3 | 38 | 53% | 10 |
| 14 | `obj:computed` | 3 | 41 | 57% | 8 |
| 15 | `dyn:receiver` | 2 | 43 | 60% | 12 |
| 16 | `class:dyn` | 2 | 45 | 62% | 11 |
| 17 | `module:builtin` | 2 | 47 | 65% | 7 |
| 18 | `date` | 2 | 49 | 68% | 11 |
| 19 | `export:mutable` | 3 | 52 | 72% | 6 |
| 20 | `bundler:interop` | 2 | 54 | 75% | 7 |
| 21 | `generic:fn` | 3 | 57 | 79% | 6 |
| 22 | `fn:call-bind` | 2 | 59 | 82% | 5 |
| 23 | `module:form` | 2 | 61 | 85% | 4 |
| 24 | `container:elem` | 2 | 63 | 88% | 4 |
| 25 | `var:hoist` | 1 | 64 | 89% | 2 |
| 26 | `op:any` | 1 | 65 | 90% | 2 |
| 27 | `call:arity` | 1 | 66 | 92% | 2 |
| 28 | `expr:assign` | 1 | 67 | 93% | 1 |
| 29 | `symbol` | 0 | 67 | 93% | 3 |
| 30 | `class:local` | 1 | 68 | 94% | 1 |
| 31 | `bigint` | 1 | 69 | 96% | 1 |
| 32 | `ts-emit:enum` | 0 | 69 | 96% | 2 |
| 33 | `module:cycle` | 1 | 70 | 97% | 1 |
| 34 | `error:shape` | 1 | 71 | 99% | 1 |
| 35 | `module:default` | 0 | 71 | 99% | 1 |
| 36 | `generator` | 1 | 72 | 100% | 1 |

## Named members inside the stdlib and module families (packages affected)

`stdlib:js`: Object.defineProperty 26; a replacement value of this type (pass a string template or  18; Object.assign 17; Set elements of type _ (Set elements must be string or numbe 16; new Set(...) 16; Object.getOwnPropertyNames 13; Object.keys 12; Set<any>.has 9; new RegExp with a  9; _ is part of the standard library types but has no scriptc l 8; Set<any>.add 8; Object.getOwnPropertyDescriptor 8; new Map(...) 8; Array.from with this argument shape 8; Symbol.iterator 7; Object.freeze of a possibly-aliased value 7; Map<any, any>.get 7; Error.stack 6; Object.getPrototypeOf 6; Map<any, any>.set 6

`stdlib:node`: require.resolve 9; process.version 4; crypto.createHash 3; new TextEncoder 3; util.inspect 3; process.versions 3; Hash.digest 3; util.inherits 3; new MessageChannel 2; Error.captureStackTrace 2; path.parse 2; util.styleText 2; new ReadableStream 2; new AbortController 2; TextEncoder.encode 2; new FormData 2; util.deprecate 2; process.nextTick 2; console.warn 2; URL.canParse 1

`module:builtin`: process 1; vm 1; node:process 1; repl 1

### Per file (supplementary)

The same greedy with each source file as the unit (an entry file or a file a site sits in; 2544 files, 320 without a site; past-gate sites left out, and files seen only past the gate dropped). At package granularity nearly every package has a long tail of families, so this view separates the broad fixes from the rare ones.

| step | fix | files with the family | newly clean files | cumulative | % |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 533 | 264 | 584 | 23% |
| 2 | `types:shape` | 337 | 194 | 778 | 31% |
| 3 | `module:ns` | 483 | 160 | 938 | 37% |
| 4 | `cjs:require` | 395 | 148 | 1086 | 43% |
| 5 | `es5:proto` | 360 | 85 | 1171 | 46% |
| 6 | `builtin:value` | 270 | 91 | 1262 | 50% |
| 7 | `fn:call-bind` | 249 | 111 | 1373 | 54% |
| 8 | `stdlib:js` | 308 | 69 | 1442 | 57% |
| 9 | `destructure` | 159 | 66 | 1508 | 59% |
| 10 | `dyn:receiver` | 273 | 68 | 1576 | 62% |
| 11 | `write:untyped` | 229 | 68 | 1644 | 65% |
| 12 | `op:any` | 149 | 54 | 1698 | 67% |
| 13 | `other` | 146 | 51 | 1749 | 69% |
| 14 | `date` | 154 | 45 | 1794 | 71% |
| 15 | `class:dyn` | 95 | 69 | 1863 | 73% |
| 16 | `stdlib:node` | 108 | 43 | 1906 | 75% |
| 17 | `obj:computed` | 325 | 43 | 1949 | 77% |
| 18 | `bundler:interop` | 252 | 251 | 2200 | 86% |
| 19 | `export:mutable` | 45 | 41 | 2241 | 88% |
| 20 | `fn:value` | 89 | 38 | 2279 | 90% |
| 21 | `var:hoist` | 91 | 35 | 2314 | 91% |
| 22 | `binding:blocked` | 35 | 35 | 2349 | 92% |
| 23 | `generic:fn` | 64 | 31 | 2380 | 94% |
| 24 | `global:sniff` | 41 | 24 | 2404 | 94% |
| 25 | `symbol` | 65 | 17 | 2421 | 95% |
| 26 | `closure:capture` | 31 | 14 | 2435 | 96% |
| 27 | `in:computed` | 22 | 10 | 2445 | 96% |
| 28 | `spread` | 10 | 8 | 2453 | 96% |
| 29 | `call:arity` | 31 | 7 | 2460 | 97% |
| 30 | `expr:assign` | 45 | 10 | 2470 | 97% |

## QuickJS embed estimate

Upper bound: 66 of 71 non-clean packages import only builtins the island shims, so a whole-package hand-off to the engine could load them. Builtins outside the shim list: {'vm': 4, 'repl': 1, 'http2': 1}. Static clean today: 1.

Combined bound (static clean or engine-servable): 67 of 72.

Statement coverage across sweeps (double counts shared modules): 68109 of 294215 statements fenced (23%).

## Analyzer crashes by cause

None.

## Internal compiler errors (SC9001: the IR validator rejected what lowering produced)

None.

## WasmGC emitter refusals (SC3001), first entry of each package only

None.

Families per non-clean package: median 10, 90th percentile 21, max 33.

Timeouts in: webpack

No result: @babel/core (0 entries), @babel/preset-env (0 entries), @typescript-eslint/parser (0 entries), @typescript-eslint/eslint-plugin (0 entries), @babel/cli (0 entries), @babel/preset-react (0 entries), @rollup/plugin-node-resolve (0 entries), @rollup/plugin-commonjs (0 entries), @babel/plugin-proposal-class-properties (0 entries), @babel/runtime (0 entries), sass (0 entries), semver (0 entries), yargs (0 entries), dotenv (0 entries), eslint-config-airbnb (0 entries), @testing-library/react (0 entries), @babel/plugin-transform-runtime (0 entries), uuid (0 entries), rxjs (0 entries), eslint-plugin-react-hooks (0 entries), rollup-plugin-commonjs (0 entries), @babel/preset-typescript (0 entries), karma-chrome-launcher (0 entries), @storybook/react (0 entries), eslint-config-airbnb-base (0 entries), @vue/cli-plugin-babel (0 entries), grunt (0 entries), postcss (0 entries), react-scripts (0 entries), less (0 entries), rollup-plugin-typescript2 (0 entries), @vue/cli-service (0 entries), nodemon (0 entries), @testing-library/jest-dom (0 entries), async (0 entries), @storybook/addon-links (0 entries), vue-loader (0 entries), tape (0 entries), @vue/cli-plugin-eslint (0 entries), babel-preset-stage-0 (0 entries), typedoc (0 entries), babel-plugin-transform-runtime (0 entries), classnames (0 entries), node-fetch (0 entries), mkdirp (0 entries), antd (0 entries), ora (0 entries), minimist (0 entries), extract-text-webpack-plugin (0 entries), ava (0 entries), react-test-renderer (0 entries), shelljs (0 entries), standard (0 entries), @testing-library/user-event (0 entries), webpack-merge (0 entries), @commitlint/config-conventional (0 entries), @rollup/plugin-typescript (0 entries), @storybook/addon-actions (0 entries), vue-router (0 entries), jsdom (0 entries), babel-runtime (0 entries), vite (0 entries), less-loader (0 entries), @commitlint/cli (0 entries), semantic-release (0 entries), babel-polyfill (0 entries), @storybook/addon-essentials (0 entries), bluebird (0 entries), eslint-plugin-jest (0 entries), gh-pages (0 entries), browserify (0 entries), colors (0 entries), should (0 entries), karma-jasmine (0 entries), eslint-loader (0 entries), babel-register (0 entries), styled-components (0 entries), jquery (0 entries), jasmine-core (0 entries), @rollup/plugin-babel (0 entries), body-parser (0 entries), uglify-js (0 entries), babel-plugin-transform-object-rest-spread (0 entries), enzyme (0 entries), rollup-plugin-peer-deps-external (0 entries), gulp-rename (0 entries), @angular/core (0 entries), mini-css-extract-plugin (0 entries), babel-preset-stage-2 (0 entries), del (0 entries), copy-webpack-plugin (0 entries), underscore (0 entries), tslint-config-prettier (0 entries), @angular/common (0 entries), @angular/compiler (0 entries), sinon-chai (0 entries), cz-conventional-changelog (0 entries), zone.js (0 entries), rollup-plugin-postcss (0 entries), react-router-dom (0 entries), @angular/platform-browser (0 entries), tsup (0 entries), webpack-bundle-analyzer (0 entries), @angular/compiler-cli (0 entries), optimize-css-assets-webpack-plugin (0 entries), uglifyjs-webpack-plugin (0 entries), reflect-metadata (0 entries), clean-webpack-plugin (0 entries), terser-webpack-plugin (0 entries), jsonwebtoken (0 entries), gulp-uglify (0 entries), redux (0 entries), @angular/platform-browser-dynamic (0 entries), @ant-design/web3-common (0 entries), js-yaml (0 entries), stylelint (0 entries), karma-mocha (0 entries), path (0 entries), grunt-contrib-jshint (0 entries), commitizen (0 entries), concurrently (0 entries), @ant-design/web3-icons (0 entries), cheerio (0 entries), babel (0 entries), karma-coverage (0 entries), eslint-plugin-flowtype (0 entries), @rollup/plugin-json (0 entries), del-cli (0 entries), jshint (0 entries), source-map-support (0 entries), react-native (0 entries), ws (0 entries), codecov (0 entries), @babel/plugin-proposal-object-rest-spread (0 entries), @angular/forms (0 entries), supertest (0 entries), @babel/polyfill (0 entries), enzyme-adapter-react-16 (0 entries), @babel/register (0 entries), babel-plugin-add-module-exports (0 entries), web-vitals (0 entries), react-redux (0 entries), tsdx (0 entries), babel-plugin-transform-class-properties (0 entries), @vitejs/plugin-vue (0 entries), karma-webpack (0 entries), bootstrap (0 entries), chokidar (0 entries), execa (0 entries), standard-version (0 entries), through2 (0 entries), vuex (0 entries), @angular/router (0 entries), rollup-plugin-uglify (0 entries), @babel/eslint-parser (0 entries), gulp-babel (0 entries), chai-as-promised (0 entries), coffee-script (0 entries), gulp-util (0 entries), case-sensitive-paths-webpack-plugin (0 entries), puppeteer (0 entries), winston (0 entries), @storybook/addon-interactions (0 entries), graphql (0 entries), esbuild (0 entries), qs (0 entries), grunt-contrib-watch (0 entries), aws-sdk (0 entries), raw-loader (0 entries), handlebars (0 entries), gulp-sourcemaps (0 entries), rollup-plugin-dts (0 entries), grunt-contrib-clean (0 entries), jest-cli (0 entries), @angular/animations (0 entries), ejs (0 entries), vue-style-loader (0 entries), dayjs (0 entries), @rollup/plugin-replace (0 entries), karma-jasmine-html-reporter (0 entries), webpack-node-externals (0 entries), @storybook/testing-library (0 entries), ajv (0 entries), @angular/cli (0 entries), jsdoc (0 entries), json-loader (0 entries), release-it (0 entries), gulp-sass (0 entries), @vue/test-utils (0 entries), cross-spawn (0 entries), jasmine (0 entries), karma-phantomjs-launcher (0 entries), karma-sourcemap-loader (0 entries), gulp-concat (0 entries), codelyzer (0 entries), postcss-import (0 entries), element-ui (0 entries), @emotion/styled (0 entries), @babel/plugin-syntax-dynamic-import (0 entries), pre-commit (0 entries), @babel/plugin-proposal-decorators (0 entries), deepmerge (0 entries), @semantic-release/git (0 entries), jasmine-spec-reporter (0 entries), cssnano (0 entries), regenerator-runtime (0 entries), cors (0 entries), date-fns (0 entries), mongoose (0 entries), rollup-plugin-vue (0 entries), nock (0 entries), babel-plugin-istanbul (0 entries), ethers (0 entries), eslint-plugin-babel (0 entries), globby (0 entries), vite-plugin-dts (0 entries), grunt-contrib-uglify (0 entries), protractor (0 entries), babel-preset-stage-3 (0 entries), size-limit (0 entries), object-assign (0 entries), @emotion/react (0 entries), identity-obj-proxy (0 entries), yeoman-generator (0 entries), eslint-config-standard-react (0 entries), eslint-config-react-app (0 entries), eslint-plugin-html (0 entries), @storybook/addons (0 entries), karma-coverage-istanbul-reporter (0 entries)

## Lists

Clean: babel-cli
