# Stratum A, npm tarballs

Packages: 302. clean: 11, deferred-only: 153, blocked: 131, dep-unavailable: 0, no-result: 7.

Partial analysis (at least one entry timed out or crashed): 2. Timed-out entries: 2. Analyzer crashes: 0. Process crashes: 0. Entries skipped on the time budget: 38.

Of the clean packages, 11 are shims under 20 statements.

Clean with dependencies too: 6 of 11 clean packages stay clean once their closure is compiled.

Verdict breakdown by hard refusal (a build-time diagnostic or package-level fallback, not a deferred fence), top families:

| family | blocked packages |
|---|---|
| other: uncategorized | 79 |
| bundler:interop: bundler output: createRequire banners (node:module), __toESM interop helpers | 28 |
| types:shape: types with no static representation: unions with fields, intersections, recursive records, | 17 |
| module:builtin: Node builtin module with no support (SC1010, node:* import fences) | 14 |
| class:dyn: class objects used dynamically: statics via a class value, extending builtins as values | 14 |
| date: Date values | 13 |
| module:form: module forms: require() of JSON, default/namespace import forms, re-exports from packages, | 12 |
| write:untyped: writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member | 8 |
| module:cycle: import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 7 |
| wasm:backend: lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entry of each  | 7 |

## Ranked families (packages affected)

Hard = packages with at least one build-time refusal or package-level fallback in the family. Reached = deferred fences on the entry path. Init = packages with an unconditional module-level site, which dies at load.

| # | family | packages | hard | init | past-gate only | sites | sites/pkg (median) |
|---|---|---|---|---|---|---|---|
| 1 | `binding:blocked` reference to a binding whose declaration was refused or has no lowering (mostly knock-on sites) | 190 | 2 | 118 | 0 | 10080 | 6 |
| 2 | `dyn:receiver` method calls, member reads, for-in, switch, spread on any/unknown receivers | 183 | 4 | 51 | 0 | 7383 | 5 |
| 3 | `stdlib:js` ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Object.assign, new Set( | 182 | 4 | 113 | 0 | 5635 | 6 |
| 4 | `write:untyped` writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member chains | 168 | 8 | 95 | 0 | 6848 | 5 |
| 5 | `dep-edge` import of an npm package that is not compiled statically | 150 | 86 | 120 | 0 | 8696 | 7 |
| 6 | `types:shape` types with no static representation: unions with fields, intersections, recursive records, any-typed members | 135 | 17 | 48 | 0 | 2433 | 3 |
| 7 | `cjs:require` require() off top level, computed, or as a value; createRequire; import.meta | 134 | 0 | 102 | 0 | 3489 | 3 |
| 8 | `cjs:shape` CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attached before reassign, table ent | 134 | 0 | 110 | 0 | 1777 | 2 |
| 9 | `es5:proto` ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Object.create, setPrototypeOf, p | 131 | 0 | 88 | 0 | 6343 | 5 |
| 10 | `other` uncategorized | 125 | 79 | 86 | 0 | 5309 | 4 |
| 11 | `fn:call-bind` Function.prototype.call/apply/bind and `arguments` on compiled functions | 122 | 1 | 14 | 0 | 1258 | 3 |
| 12 | `stdlib:node` Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 111 | 0 | 50 | 0 | 748 | 2 |
| 13 | `date` Date values | 109 | 13 | 44 | 0 | 1480 | 3 |
| 14 | `destructure` destructuring beyond typed record sources: absent fields, optional patterns, rest over dynamic values, catch b | 101 | 3 | 44 | 0 | 1361 | 2 |
| 15 | `obj:computed` runtime-keyed (computed-key) object literals holding methods, spreads, or non-scalar values | 92 | 0 | 33 | 0 | 5555 | 4 |
| 16 | `op:any` operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, truthiness coercions | 92 | 0 | 6 | 0 | 3377 | 5 |
| 17 | `builtin:value` builtin globals, Math or string methods as values (#84) | 86 | 0 | 29 | 0 | 1621 | 3 |
| 18 | `fn:value` functions as values: optional/defaulted params, overloads, generics kept open | 82 | 0 | 30 | 0 | 1463 | 3 |
| 19 | `module:ns` module namespace objects as values; library functions as values | 64 | 0 | 42 | 0 | 1507 | 4 |
| 20 | `class:dyn` class objects used dynamically: statics via a class value, extending builtins as values | 60 | 14 | 42 | 0 | 643 | 3 |
| 21 | `global:sniff` reads or typeof of undeclared globals (UMD define/module/self/window, build flags like ngDevMode, devtools hoo | 55 | 0 | 15 | 0 | 755 | 2 |
| 22 | `var:hoist` `var` read inside a hoisted function declared above it (generated parsers, bundles) | 49 | 0 | 3 | 0 | 3336 | 3 |
| 23 | `symbol` symbol-keyed access outside class fields | 47 | 1 | 8 | 0 | 323 | 3 |
| 24 | `generic:fn` generic methods and arrows in forms with no monomorphized home | 46 | 4 | 32 | 0 | 480 | 2 |
| 25 | `in:computed` `in` / hasOwnProperty with computed keys, dyn.hasKey | 29 | 0 | 0 | 0 | 93 | 1 |
| 26 | `bundler:interop` bundler output: createRequire banners (node:module), __toESM interop helpers | 28 | 28 | 28 | 0 | 293 | 1 |
| 27 | `error:shape` Error specifics: constructor options (cause), overriding Error methods, non-Error throws read as Error | 27 | 6 | 6 | 0 | 104 | 2 |
| 28 | `ts-emit:enum` compiled TypeScript enums in shipped JS: E[E["A"] = 0] = "A" | 22 | 0 | 22 | 0 | 1368 | 13 |
| 29 | `expr:assign` assignments and side effects in expression position (x op= e as a value, void effectful, comma forms) | 22 | 1 | 4 | 0 | 446 | 3 |
| 30 | `closure:capture` bindings captured through a plain nested function with no static storage | 20 | 0 | 0 | 0 | 463 | 4 |
| 31 | `call:arity` calls omitting required parameters, optional-chaining on unusual values, delete | 18 | 0 | 3 | 0 | 220 | 3 |
| 32 | `module:builtin` Node builtin module with no support (SC1010, node:* import fences) | 18 | 14 | 15 | 0 | 31 | 1 |
| 33 | `export:mutable` exporting a mutable binding by reference (live bindings) | 17 | 0 | 17 | 0 | 61 | 1 |
| 34 | `spread` spreads beyond same-shape arrays and one-property conditional object spreads | 16 | 0 | 1 | 0 | 24 | 1 |
| 35 | `for:multi` multi-declarator `for (let i = 0, n = ...)` | 15 | 0 | 0 | 0 | 62 | 2 |
| 36 | `container:elem` Map/Set/array element types outside the supported kinds | 15 | 0 | 12 | 0 | 57 | 2 |
| 37 | `class:local` classes declared inside functions, class expressions, mixins | 13 | 0 | 2 | 0 | 584 | 8 |
| 38 | `bigint` bigint | 12 | 0 | 5 | 0 | 103 | 3 |
| 39 | `module:form` module forms: require() of JSON, default/namespace import forms, re-exports from packages, export = / import = | 12 | 12 | 12 | 0 | 14 | 1 |
| 40 | `generator` async generators, generator methods, for-await beyond streams, .next(value) | 11 | 1 | 1 | 0 | 52 | 2 |
| 41 | `module:cycle` import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 7 | 7 | 7 | 0 | 14 | 1 |
| 42 | `wasm:backend` lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entry of each package) | 7 | 7 | 7 | 0 | 7 | 1 |
| 43 | `types:narrow` narrowing forms: hand-written type predicates, ?? that changes the result type, tuple/string index shapes | 5 | 0 | 0 | 0 | 10 | 1 |
| 44 | `syntax` other syntax forms the frontend names as unsupported | 4 | 0 | 1 | 0 | 36 | 6 |
| 45 | `module:default` default exports and default imports (SC1012) | 4 | 4 | 4 | 0 | 4 | 1 |
| 46 | `generic:class` generic class hierarchies | 2 | 1 | 2 | 0 | 10 | 6 |
| 47 | `cfg:strict-off` tsconfig disables strictNullChecks (SC0002) | 2 | 2 | 2 | 0 | 4 | 2 |
| 48 | `ice` internal compiler error (SC9001) | 2 | 2 | 2 | 0 | 3 | 2 |
| 49 | `tsgo:panic` typescript-go checker panic (SC0004) | 2 | 0 | 0 | 0 | 2 | 1 |
| 50 | `decorator` decorators (field, method, and generic class decorators) | 2 | 0 | 1 | 0 | 2 | 1 |
| 51 | `tsc:missing-dep` unresolved import (dependency or generated file absent; survey artifact, not a language gap) | 1 | 1 | 1 | 0 | 1 | 1 |
| 52 | `esm-in-cjs` ES module syntax in a .ts/.js file Node would load as CommonJS (package has no "type": "module") | 1 | 1 | 1 | 0 | 1 | 1 |
| 53 | `typeof:static` typeof on statically typed values | 1 | 0 | 0 | 0 | 1 | 1 |

## Greedy unlock order

Population: 293 packages with a complete analysis (9 partial or empty results are left out; they cannot be called clean). A package counts as clean once every family it has is fixed. Each step takes the family that cleans the most packages; when none can finish a package, the one with the most leverage. `tsc:missing-dep` is the survey environment, so it is treated as already fixed; packages whose every entry stopped at preflight are left out, because nothing past the type check was seen.

### Every family, deferred fences included

Population with at least one entry past preflight: 291. Clean at the start: 11.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 11 | 22 | 8% | 133 |
| 2 | `binding:blocked` | 6 | 28 | 10% | 6 |
| 3 | `cjs:require` | 3 | 31 | 11% | 132 |
| 4 | `dyn:receiver` | 7 | 38 | 13% | 181 |
| 5 | `stdlib:node` | 5 | 43 | 15% | 109 |
| 6 | `write:untyped` | 3 | 46 | 16% | 166 |
| 7 | `es5:proto` | 3 | 49 | 17% | 129 |
| 8 | `stdlib:js` | 3 | 52 | 18% | 180 |
| 9 | `other` | 6 | 58 | 20% | 123 |
| 10 | `types:shape` | 5 | 63 | 22% | 133 |
| 11 | `date` | 5 | 68 | 23% | 107 |
| 12 | `obj:computed` | 5 | 73 | 25% | 90 |
| 13 | `module:ns` | 6 | 79 | 27% | 63 |
| 14 | `fn:call-bind` | 5 | 84 | 29% | 120 |
| 15 | `bundler:interop` | 6 | 90 | 31% | 28 |
| 16 | `op:any` | 5 | 95 | 33% | 90 |
| 17 | `destructure` | 6 | 101 | 35% | 100 |
| 18 | `fn:value` | 8 | 109 | 37% | 81 |
| 19 | `class:dyn` | 10 | 119 | 41% | 59 |
| 20 | `builtin:value` | 9 | 128 | 44% | 84 |
| 21 | `global:sniff` | 9 | 137 | 47% | 53 |
| 22 | `var:hoist` | 12 | 149 | 51% | 48 |
| 23 | `generic:fn` | 10 | 159 | 55% | 45 |
| 24 | `export:mutable` | 8 | 167 | 57% | 17 |
| 25 | `symbol` | 7 | 174 | 60% | 46 |
| 26 | `in:computed` | 8 | 182 | 63% | 29 |
| 27 | `ts-emit:enum` | 8 | 190 | 65% | 22 |
| 28 | `error:shape` | 7 | 197 | 68% | 26 |
| 29 | `closure:capture` | 6 | 203 | 70% | 20 |
| 30 | `expr:assign` | 6 | 209 | 72% | 22 |
| 31 | `call:arity` | 7 | 216 | 74% | 18 |
| 32 | `module:builtin` | 6 | 222 | 76% | 17 |
| 33 | `spread` | 6 | 228 | 78% | 15 |
| 34 | `for:multi` | 5 | 233 | 80% | 14 |
| 35 | `wasm:backend` | 5 | 238 | 82% | 7 |
| 36 | `class:local` | 5 | 243 | 84% | 13 |
| 37 | `container:elem` | 6 | 249 | 86% | 14 |
| 38 | `module:form` | 7 | 256 | 88% | 11 |
| 39 | `generator` | 7 | 263 | 90% | 11 |
| 40 | `bigint` | 6 | 269 | 92% | 11 |
| 41 | `module:cycle` | 6 | 275 | 95% | 7 |
| 42 | `types:narrow` | 4 | 279 | 96% | 5 |
| 43 | `syntax` | 2 | 281 | 97% | 4 |
| 44 | `module:default` | 2 | 283 | 97% | 4 |
| 45 | `ice` | 2 | 285 | 98% | 2 |
| 46 | `decorator` | 2 | 287 | 99% | 2 |
| 47 | `typeof:static` | 1 | 288 | 99% | 1 |
| 48 | `tsgo:panic` | 1 | 289 | 99% | 1 |
| 49 | `generic:class` | 1 | 290 | 100% | 1 |
| 50 | `esm-in-cjs` | 1 | 291 | 100% | 1 |

### Build-time refusals only (the build passes; deferred fences remain)

Population with at least one entry past preflight: 291. Clean at the start: 165.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `other` | 42 | 207 | 71% | 77 |
| 2 | `bundler:interop` | 13 | 220 | 76% | 28 |
| 3 | `types:shape` | 8 | 228 | 78% | 17 |
| 4 | `module:builtin` | 8 | 236 | 81% | 13 |
| 5 | `module:form` | 7 | 243 | 84% | 11 |
| 6 | `wasm:backend` | 7 | 250 | 86% | 7 |
| 7 | `module:cycle` | 7 | 257 | 88% | 7 |
| 8 | `write:untyped` | 4 | 261 | 90% | 7 |
| 9 | `class:dyn` | 3 | 264 | 91% | 14 |
| 10 | `date` | 4 | 268 | 92% | 12 |
| 11 | `error:shape` | 4 | 272 | 93% | 6 |
| 12 | `generic:fn` | 4 | 276 | 95% | 4 |
| 13 | `dyn:receiver` | 3 | 279 | 96% | 4 |
| 14 | `stdlib:js` | 2 | 281 | 97% | 4 |
| 15 | `destructure` | 2 | 283 | 97% | 3 |
| 16 | `module:default` | 2 | 285 | 98% | 4 |
| 17 | `ice` | 2 | 287 | 99% | 2 |
| 18 | `generator` | 1 | 288 | 99% | 1 |
| 19 | `fn:call-bind` | 1 | 289 | 99% | 1 |
| 20 | `expr:assign` | 1 | 290 | 100% | 1 |
| 21 | `symbol` | 0 | 290 | 100% | 1 |
| 22 | `esm-in-cjs` | 1 | 291 | 100% | 1 |

### Loads: no build-time refusal and no unconditional module-level fence

Population with at least one entry past preflight: 291. Clean at the start: 30.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 14 | 44 | 15% | 109 |
| 2 | `cjs:require` | 18 | 62 | 21% | 100 |
| 3 | `write:untyped` | 7 | 69 | 24% | 94 |
| 4 | `stdlib:js` | 6 | 75 | 26% | 112 |
| 5 | `other` | 9 | 84 | 29% | 84 |
| 6 | `es5:proto` | 7 | 91 | 31% | 87 |
| 7 | `stdlib:node` | 13 | 104 | 36% | 49 |
| 8 | `module:ns` | 10 | 114 | 39% | 41 |
| 9 | `export:mutable` | 9 | 123 | 42% | 17 |
| 10 | `destructure` | 8 | 131 | 45% | 44 |
| 11 | `dyn:receiver` | 7 | 138 | 47% | 49 |
| 12 | `bundler:interop` | 7 | 145 | 50% | 28 |
| 13 | `types:shape` | 8 | 153 | 53% | 47 |
| 14 | `fn:value` | 7 | 160 | 55% | 30 |
| 15 | `builtin:value` | 7 | 167 | 57% | 28 |
| 16 | `date` | 6 | 173 | 59% | 43 |
| 17 | `class:dyn` | 8 | 181 | 62% | 41 |
| 18 | `obj:computed` | 9 | 190 | 65% | 32 |
| 19 | `generic:fn` | 11 | 201 | 69% | 31 |
| 20 | `ts-emit:enum` | 9 | 210 | 72% | 22 |
| 21 | `global:sniff` | 10 | 220 | 76% | 14 |
| 22 | `fn:call-bind` | 9 | 229 | 79% | 14 |
| 23 | `module:builtin` | 8 | 237 | 81% | 14 |
| 24 | `wasm:backend` | 6 | 243 | 84% | 7 |
| 25 | `module:form` | 6 | 249 | 86% | 11 |
| 26 | `container:elem` | 4 | 253 | 87% | 11 |
| 27 | `module:cycle` | 4 | 257 | 88% | 7 |
| 28 | `error:shape` | 4 | 261 | 90% | 6 |
| 29 | `op:any` | 3 | 264 | 91% | 6 |
| 30 | `var:hoist` | 3 | 267 | 92% | 3 |
| 31 | `binding:blocked` | 3 | 270 | 93% | 3 |
| 32 | `symbol` | 2 | 272 | 93% | 8 |
| 33 | `bigint` | 4 | 276 | 95% | 4 |
| 34 | `expr:assign` | 3 | 279 | 96% | 4 |
| 35 | `call:arity` | 2 | 281 | 97% | 3 |
| 36 | `ice` | 2 | 283 | 97% | 2 |
| 37 | `class:local` | 2 | 285 | 98% | 2 |
| 38 | `module:default` | 1 | 286 | 98% | 4 |
| 39 | `spread` | 1 | 287 | 99% | 1 |
| 40 | `generator` | 1 | 288 | 99% | 1 |
| 41 | `esm-in-cjs` | 1 | 289 | 99% | 1 |
| 42 | `decorator` | 1 | 290 | 100% | 1 |
| 43 | `syntax` | 0 | 290 | 100% | 1 |
| 44 | `generic:class` | 1 | 291 | 100% | 1 |

## Named members inside the stdlib and module families (packages affected)

`stdlib:js`: Object.defineProperty 79; Set elements of type _ (Set elements must be string or numbe 51; a replacement value of this type (pass a string template or  44; Object.assign 40; new Set(...) 37; Object.getOwnPropertyNames 33; Object.keys 30; Object.getOwnPropertyDescriptor 28; Object.getPrototypeOf 28; Set<any>.add 25; Array.from with this argument shape 24; Set<any>.has 21; new RegExp with a  20; _ is part of the standard library types but has no scriptc l 17; Array.isArray 16; Object.freeze of a possibly-aliased value 16; new Map(...) 15; any[].reduce 15; Symbol.iterator 14; Map<any, any>.set 13

`stdlib:node`: require.resolve 28; Error.captureStackTrace 11; process.versions 8; process.version 8; util.inherits 8; new TextDecoder 7; path.parse 6; new TextEncoder 6; Error.stackTraceLimit 5; new AbortController 5; tty.isatty 5; util.inspect 5; require.extensions 5; console.warn 5; console.log 4; util.styleText 4; Require.resolve 4; console.error 4; TextEncoder.encode 4; util.promisify 4

`module:builtin`: node:process 4; process 1; vm 1; repl 1; node:v8 1

`module:form`: module namespace objects as first-class values (access _ mem 1

### Per file (supplementary)

The same greedy with each source file as the unit (an entry file or a file a site sits in; 7851 files, 1568 without a site; past-gate sites left out, and files seen only past the gate dropped). At package granularity nearly every package has a long tail of families, so this view separates the broad fixes from the rare ones.

| step | fix | files with the family | newly clean files | cumulative | % |
|---|---|---|---|---|---|
| 1 | `write:untyped` | 1602 | 728 | 2296 | 29% |
| 2 | `cjs:shape` | 961 | 422 | 2718 | 35% |
| 3 | `binding:blocked` | 309 | 309 | 3027 | 39% |
| 4 | `types:shape` | 672 | 289 | 3316 | 42% |
| 5 | `cjs:require` | 1160 | 250 | 3566 | 45% |
| 6 | `dyn:receiver` | 1113 | 252 | 3818 | 49% |
| 7 | `obj:computed` | 832 | 242 | 4060 | 52% |
| 8 | `bundler:interop` | 255 | 244 | 4304 | 55% |
| 9 | `destructure` | 579 | 242 | 4546 | 58% |
| 10 | `stdlib:js` | 1171 | 247 | 4793 | 61% |
| 11 | `es5:proto` | 1113 | 348 | 5141 | 65% |
| 12 | `module:ns` | 615 | 306 | 5447 | 69% |
| 13 | `fn:call-bind` | 477 | 208 | 5655 | 72% |
| 14 | `date` | 497 | 206 | 5861 | 75% |
| 15 | `class:dyn` | 281 | 203 | 6064 | 77% |
| 16 | `builtin:value` | 389 | 179 | 6243 | 80% |
| 17 | `op:any` | 383 | 167 | 6410 | 82% |
| 18 | `other` | 334 | 149 | 6559 | 84% |
| 19 | `stdlib:node` | 264 | 146 | 6705 | 85% |
| 20 | `generic:fn` | 242 | 139 | 6844 | 87% |
| 21 | `fn:value` | 423 | 120 | 6964 | 89% |
| 22 | `class:local` | 244 | 207 | 7171 | 91% |
| 23 | `global:sniff` | 144 | 76 | 7247 | 92% |
| 24 | `var:hoist` | 155 | 68 | 7315 | 93% |
| 25 | `symbol` | 150 | 70 | 7385 | 94% |
| 26 | `export:mutable` | 61 | 58 | 7443 | 95% |
| 27 | `call:arity` | 89 | 53 | 7496 | 95% |
| 28 | `closure:capture` | 66 | 46 | 7542 | 96% |
| 29 | `ts-emit:enum` | 52 | 40 | 7582 | 97% |
| 30 | `expr:assign` | 73 | 37 | 7619 | 97% |

## QuickJS embed estimate

Upper bound: 271 of 282 non-clean packages import only builtins the island shims, so a whole-package hand-off to the engine could load them. Builtins outside the shim list: {'vm': 7, 'http2': 3, 'repl': 1, 'cluster': 1}. Static clean today: 11.

Combined bound (static clean or engine-servable): 282 of 293.

Statement coverage across sweeps (double counts shared modules): 160879 of 672739 statements fenced (24%).

## Analyzer crashes by cause

None.

## Internal compiler errors (SC9001: the IR validator rejected what lowering produced)

| packages | sites | cause | examples |
|---|---|---|---|
| 1 | 1 | internal compiler error: dynFromJsval operand must be jsval, got fN | uuid |
| 1 | 1 | internal compiler error: local "_" has bare unit type undefinedT | jest-cli |
| 1 | 1 | internal compiler error: bare unitLit '_' outside a unionWrap | jest-cli |

## WasmGC emitter refusals (SC3001), first entry of each package only

| packages | sites | cause | examples |
|---|---|---|---|
| 4 | 4 | the wasm backend does not support this construct yet (jsOp:defineGetter-order) | @vue/cli-plugin-eslint, eslint-plugin-jest, rollup-plugin-postcss, web-vitals |
| 1 | 1 | the wasm backend does not support this construct yet (expr:regexLit:annexb-brace-literal) | async |
| 1 | 1 | the wasm backend does not support this construct yet (fn:async:await-position) | mkdirp |
| 1 | 1 | the wasm backend does not support this construct yet (unionKeyGet:arm:array) | path |

Families per non-clean package: median 8, 90th percentile 19, max 33.

Timeouts in: webpack, sass

No result: @babel/cli (0 entries), react-scripts (0 entries), babel-runtime (0 entries), sinon-chai (1 entries), del-cli (0 entries), aws-sdk (0 entries, ENOENT: no such file or directory, open '/home/tsinter/.cache/tsinter-dl/survey/npm/aws-sdk/node_modules/aws-sdk/package.json'), jsdoc (0 entries)

## Lists

Clean: @babel/preset-react, @babel/preset-typescript, @commitlint/config-conventional, @rollup/plugin-json, @storybook/addon-actions, babel, babel-cli, gulp-rename, json-loader, react-router-dom, tslint-config-prettier
