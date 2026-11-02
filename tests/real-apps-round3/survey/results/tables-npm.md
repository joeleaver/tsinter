# Stratum A, npm tarballs

Packages: 302. clean: 11, deferred-only: 175, blocked: 108, dep-unavailable: 0, no-result: 8.

Partial analysis (at least one entry timed out or crashed): 6. Timed-out entries: 1. Analyzer crashes: 9. Process crashes: 0. Entries skipped on the time budget: 38.

Of the clean packages, 11 are shims under 20 statements.

Clean with dependencies too: 6 of 11 clean packages stay clean once their closure is compiled.

Verdict breakdown by hard refusal (a build-time diagnostic or package-level fallback, not a deferred fence), top families:

| family | blocked packages |
|---|---|
| bundler:interop: bundler output: createRequire banners (node:module), __toESM interop helpers | 28 |
| types:shape: types with no static representation: unions with fields, intersections, recursive records, | 17 |
| module:form: module forms: require() of JSON, default/namespace import forms, re-exports from packages, | 17 |
| ice: internal compiler error (SC9001) | 15 |
| module:builtin: Node builtin module with no support (SC1010, node:* import fences) | 13 |
| date: Date values | 12 |
| module:cycle: import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 12 |
| class:dyn: class objects used dynamically: statics via a class value, extending builtins as values | 11 |
| wasm:backend: lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entry of each  | 11 |
| write:untyped: writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member | 8 |

## Ranked families (packages affected)

Hard = packages with at least one build-time refusal or package-level fallback in the family. Reached = deferred fences on the entry path. Init = packages with an unconditional module-level site, which dies at load.

| # | family | packages | hard | init | past-gate only | sites | sites/pkg (median) |
|---|---|---|---|---|---|---|---|
| 1 | `binding:blocked` reference to a binding whose declaration was refused or has no lowering (mostly knock-on sites) | 189 | 0 | 118 | 0 | 10131 | 6 |
| 2 | `dyn:receiver` method calls, member reads, for-in, switch, spread on any/unknown receivers | 182 | 2 | 48 | 0 | 7595 | 5 |
| 3 | `stdlib:js` ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Object.assign, new Set( | 182 | 4 | 114 | 0 | 6024 | 6 |
| 4 | `write:untyped` writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member chains | 166 | 8 | 94 | 0 | 6900 | 5 |
| 5 | `dep-edge` import of an npm package that is not compiled statically | 150 | 86 | 120 | 0 | 9307 | 7 |
| 6 | `cjs:require` require() off top level, computed, or as a value; createRequire; import.meta | 134 | 0 | 102 | 0 | 3486 | 3 |
| 7 | `cjs:shape` CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attached before reassign, table ent | 134 | 0 | 110 | 0 | 1774 | 2 |
| 8 | `types:shape` types with no static representation: unions with fields, intersections, recursive records, any-typed members | 133 | 17 | 48 | 0 | 2594 | 3 |
| 9 | `es5:proto` ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Object.create, setPrototypeOf, p | 132 | 0 | 88 | 0 | 5624 | 5 |
| 10 | `fn:call-bind` Function.prototype.call/apply/bind and `arguments` on compiled functions | 119 | 1 | 14 | 0 | 1229 | 3 |
| 11 | `stdlib:node` Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 110 | 0 | 50 | 0 | 745 | 2 |
| 12 | `date` Date values | 108 | 12 | 43 | 0 | 1538 | 3 |
| 13 | `destructure` destructuring beyond typed record sources: absent fields, optional patterns, rest over dynamic values, catch b | 101 | 3 | 44 | 0 | 1374 | 2 |
| 14 | `op:any` operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, truthiness coercions | 92 | 0 | 6 | 0 | 3461 | 5 |
| 15 | `obj:computed` runtime-keyed (computed-key) object literals holding methods, spreads, or non-scalar values | 90 | 0 | 33 | 0 | 2519 | 4 |
| 16 | `builtin:value` builtin globals, Math or string methods as values (#84) | 84 | 0 | 29 | 0 | 1610 | 3 |
| 17 | `fn:value` functions as values: optional/defaulted params, overloads, generics kept open | 83 | 0 | 30 | 0 | 1490 | 3 |
| 18 | `module:ns` module namespace objects as values; library functions as values | 63 | 0 | 41 | 0 | 1496 | 4 |
| 19 | `class:dyn` class objects used dynamically: statics via a class value, extending builtins as values | 59 | 11 | 40 | 0 | 623 | 3 |
| 20 | `global:sniff` reads or typeof of undeclared globals (UMD define/module/self/window, build flags like ngDevMode, devtools hoo | 54 | 0 | 15 | 0 | 1076 | 2 |
| 21 | `var:hoist` `var` read inside a hoisted function declared above it (generated parsers, bundles) | 53 | 0 | 3 | 0 | 3370 | 3 |
| 22 | `other` uncategorized | 47 | 2 | 12 | 0 | 239 | 2 |
| 23 | `symbol` symbol-keyed access outside class fields | 46 | 0 | 7 | 0 | 336 | 3 |
| 24 | `generic:fn` generic methods and arrows in forms with no monomorphized home | 44 | 2 | 30 | 0 | 475 | 2 |
| 25 | `bundler:interop` bundler output: createRequire banners (node:module), __toESM interop helpers | 28 | 28 | 28 | 0 | 293 | 1 |
| 26 | `in:computed` `in` / hasOwnProperty with computed keys, dyn.hasKey | 28 | 0 | 0 | 0 | 87 | 2 |
| 27 | `error:shape` Error specifics: constructor options (cause), overriding Error methods, non-Error throws read as Error | 25 | 5 | 5 | 0 | 102 | 2 |
| 28 | `ts-emit:enum` compiled TypeScript enums in shipped JS: E[E["A"] = 0] = "A" | 22 | 0 | 22 | 0 | 1472 | 13 |
| 29 | `expr:assign` assignments and side effects in expression position (x op= e as a value, void effectful, comma forms) | 21 | 0 | 3 | 0 | 430 | 2 |
| 30 | `closure:capture` bindings captured through a plain nested function with no static storage | 20 | 0 | 0 | 0 | 539 | 8 |
| 31 | `call:arity` calls omitting required parameters, optional-chaining on unusual values, delete | 19 | 0 | 3 | 0 | 249 | 3 |
| 32 | `export:mutable` exporting a mutable binding by reference (live bindings) | 17 | 0 | 17 | 0 | 61 | 1 |
| 33 | `module:builtin` Node builtin module with no support (SC1010, node:* import fences) | 17 | 13 | 14 | 0 | 30 | 1 |
| 34 | `module:form` module forms: require() of JSON, default/namespace import forms, re-exports from packages, export = / import = | 17 | 17 | 17 | 0 | 20 | 1 |
| 35 | `spread` spreads beyond same-shape arrays and one-property conditional object spreads | 16 | 0 | 1 | 0 | 24 | 1 |
| 36 | `ice` internal compiler error (SC9001) | 15 | 15 | 15 | 0 | 192 | 2 |
| 37 | `container:elem` Map/Set/array element types outside the supported kinds | 15 | 0 | 12 | 0 | 57 | 2 |
| 38 | `for:multi` multi-declarator `for (let i = 0, n = ...)` | 14 | 0 | 0 | 0 | 60 | 2 |
| 39 | `bigint` bigint | 13 | 0 | 5 | 0 | 104 | 2 |
| 40 | `class:local` classes declared inside functions, class expressions, mixins | 12 | 0 | 2 | 0 | 579 | 18 |
| 41 | `module:cycle` import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 12 | 12 | 12 | 0 | 25 | 2 |
| 42 | `wasm:backend` lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entry of each package) | 11 | 11 | 11 | 0 | 11 | 1 |
| 43 | `generator` async generators, generator methods, for-await beyond streams, .next(value) | 10 | 1 | 1 | 0 | 50 | 3 |
| 44 | `types:narrow` narrowing forms: hand-written type predicates, ?? that changes the result type, tuple/string index shapes | 5 | 0 | 0 | 0 | 10 | 1 |
| 45 | `syntax` other syntax forms the frontend names as unsupported | 4 | 0 | 1 | 0 | 33 | 6 |
| 46 | `module:default` default exports and default imports (SC1012) | 4 | 4 | 4 | 0 | 4 | 1 |
| 47 | `generic:class` generic class hierarchies | 2 | 1 | 2 | 0 | 10 | 6 |
| 48 | `cfg:strict-off` tsconfig disables strictNullChecks (SC0002) | 2 | 2 | 2 | 0 | 4 | 2 |
| 49 | `tsgo:panic` typescript-go checker panic (SC0004) | 2 | 0 | 0 | 0 | 2 | 1 |
| 50 | `tsc:missing-dep` unresolved import (dependency or generated file absent; survey artifact, not a language gap) | 1 | 1 | 1 | 0 | 1 | 1 |
| 51 | `typeof:static` typeof on statically typed values | 1 | 0 | 0 | 0 | 1 | 1 |
| 52 | `decorator` decorators (field, method, and generic class decorators) | 1 | 0 | 1 | 0 | 1 | 1 |

## Greedy unlock order

Population: 289 packages with a complete analysis (13 partial or empty results are left out; they cannot be called clean). A package counts as clean once every family it has is fixed. Each step takes the family that cleans the most packages; when none can finish a package, the one with the most leverage. `tsc:missing-dep` is the survey environment, so it is treated as already fixed; packages whose every entry stopped at preflight are left out, because nothing past the type check was seen.

### Every family, deferred fences included

Population with at least one entry past preflight: 287. Clean at the start: 11.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 11 | 22 | 8% | 129 |
| 2 | `binding:blocked` | 7 | 29 | 10% | 7 |
| 3 | `cjs:require` | 3 | 32 | 11% | 131 |
| 4 | `dyn:receiver` | 6 | 38 | 13% | 178 |
| 5 | `stdlib:node` | 5 | 43 | 15% | 108 |
| 6 | `stdlib:js` | 3 | 46 | 16% | 178 |
| 7 | `es5:proto` | 5 | 51 | 18% | 130 |
| 8 | `write:untyped` | 3 | 54 | 19% | 163 |
| 9 | `types:shape` | 4 | 58 | 20% | 130 |
| 10 | `date` | 5 | 63 | 22% | 106 |
| 11 | `op:any` | 5 | 68 | 24% | 89 |
| 12 | `module:ns` | 5 | 73 | 25% | 60 |
| 13 | `obj:computed` | 5 | 78 | 27% | 88 |
| 14 | `fn:value` | 6 | 84 | 29% | 80 |
| 15 | `fn:call-bind` | 5 | 89 | 31% | 115 |
| 16 | `destructure` | 7 | 96 | 33% | 98 |
| 17 | `class:dyn` | 7 | 103 | 36% | 57 |
| 18 | `bundler:interop` | 9 | 112 | 39% | 27 |
| 19 | `builtin:value` | 6 | 118 | 41% | 82 |
| 20 | `global:sniff` | 8 | 126 | 44% | 51 |
| 21 | `var:hoist` | 10 | 136 | 47% | 53 |
| 22 | `generic:fn` | 6 | 142 | 49% | 42 |
| 23 | `ice` | 7 | 149 | 52% | 15 |
| 24 | `symbol` | 6 | 155 | 54% | 45 |
| 25 | `ts-emit:enum` | 7 | 162 | 56% | 22 |
| 26 | `export:mutable` | 7 | 169 | 59% | 17 |
| 27 | `other` | 7 | 176 | 61% | 46 |
| 28 | `in:computed` | 8 | 184 | 64% | 28 |
| 29 | `error:shape` | 8 | 192 | 67% | 24 |
| 30 | `module:form` | 7 | 199 | 69% | 14 |
| 31 | `module:builtin` | 6 | 205 | 71% | 16 |
| 32 | `closure:capture` | 5 | 210 | 73% | 20 |
| 33 | `module:cycle` | 6 | 216 | 75% | 11 |
| 34 | `expr:assign` | 5 | 221 | 77% | 20 |
| 35 | `call:arity` | 6 | 227 | 79% | 19 |
| 36 | `wasm:backend` | 7 | 234 | 82% | 11 |
| 37 | `spread` | 7 | 241 | 84% | 15 |
| 38 | `for:multi` | 6 | 247 | 86% | 13 |
| 39 | `container:elem` | 5 | 252 | 88% | 14 |
| 40 | `class:local` | 7 | 259 | 90% | 12 |
| 41 | `bigint` | 7 | 266 | 93% | 12 |
| 42 | `generator` | 8 | 274 | 95% | 10 |
| 43 | `types:narrow` | 4 | 278 | 97% | 5 |
| 44 | `syntax` | 3 | 281 | 98% | 4 |
| 45 | `module:default` | 2 | 283 | 99% | 3 |
| 46 | `typeof:static` | 1 | 284 | 99% | 1 |
| 47 | `tsgo:panic` | 1 | 285 | 99% | 1 |
| 48 | `generic:class` | 1 | 286 | 100% | 1 |
| 49 | `decorator` | 1 | 287 | 100% | 1 |

### Build-time refusals only (the build passes; deferred fences remain)

Population with at least one entry past preflight: 287. Clean at the start: 185.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `ice` | 14 | 199 | 69% | 15 |
| 2 | `bundler:interop` | 11 | 210 | 73% | 27 |
| 3 | `module:form` | 11 | 221 | 77% | 14 |
| 4 | `wasm:backend` | 11 | 232 | 81% | 11 |
| 5 | `types:shape` | 8 | 240 | 84% | 17 |
| 6 | `module:cycle` | 9 | 249 | 87% | 11 |
| 7 | `module:builtin` | 9 | 258 | 90% | 12 |
| 8 | `write:untyped` | 4 | 262 | 91% | 7 |
| 9 | `class:dyn` | 3 | 265 | 92% | 11 |
| 10 | `date` | 5 | 270 | 94% | 10 |
| 11 | `error:shape` | 4 | 274 | 95% | 5 |
| 12 | `stdlib:js` | 3 | 277 | 97% | 4 |
| 13 | `destructure` | 2 | 279 | 97% | 3 |
| 14 | `generic:fn` | 2 | 281 | 98% | 2 |
| 15 | `module:default` | 1 | 282 | 98% | 3 |
| 16 | `other` | 2 | 284 | 99% | 2 |
| 17 | `dyn:receiver` | 1 | 285 | 99% | 2 |
| 18 | `generator` | 1 | 286 | 100% | 1 |
| 19 | `fn:call-bind` | 1 | 287 | 100% | 1 |

### Loads: no build-time refusal and no unconditional module-level fence

Population with at least one entry past preflight: 287. Clean at the start: 29.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `cjs:shape` | 14 | 43 | 15% | 107 |
| 2 | `cjs:require` | 15 | 58 | 20% | 100 |
| 3 | `write:untyped` | 8 | 66 | 23% | 92 |
| 4 | `stdlib:js` | 7 | 73 | 25% | 110 |
| 5 | `stdlib:node` | 7 | 80 | 28% | 49 |
| 6 | `es5:proto` | 12 | 92 | 32% | 86 |
| 7 | `module:ns` | 9 | 101 | 35% | 39 |
| 8 | `destructure` | 8 | 109 | 38% | 44 |
| 9 | `export:mutable` | 8 | 117 | 41% | 17 |
| 10 | `bundler:interop` | 7 | 124 | 43% | 27 |
| 11 | `types:shape` | 6 | 130 | 45% | 46 |
| 12 | `ice` | 7 | 137 | 48% | 15 |
| 13 | `dyn:receiver` | 7 | 144 | 50% | 45 |
| 14 | `fn:value` | 7 | 151 | 53% | 30 |
| 15 | `builtin:value` | 7 | 158 | 55% | 28 |
| 16 | `obj:computed` | 7 | 165 | 57% | 31 |
| 17 | `date` | 7 | 172 | 60% | 41 |
| 18 | `class:dyn` | 10 | 182 | 63% | 38 |
| 19 | `generic:fn` | 8 | 190 | 66% | 28 |
| 20 | `ts-emit:enum` | 8 | 198 | 69% | 22 |
| 21 | `global:sniff` | 9 | 207 | 72% | 13 |
| 22 | `wasm:backend` | 10 | 217 | 76% | 11 |
| 23 | `module:form` | 8 | 225 | 78% | 14 |
| 24 | `fn:call-bind` | 8 | 233 | 81% | 14 |
| 25 | `module:builtin` | 7 | 240 | 84% | 13 |
| 26 | `module:cycle` | 6 | 246 | 86% | 11 |
| 27 | `other` | 6 | 252 | 88% | 12 |
| 28 | `container:elem` | 5 | 257 | 90% | 11 |
| 29 | `binding:blocked` | 4 | 261 | 91% | 4 |
| 30 | `op:any` | 3 | 264 | 92% | 6 |
| 31 | `error:shape` | 3 | 267 | 93% | 5 |
| 32 | `var:hoist` | 3 | 270 | 94% | 3 |
| 33 | `symbol` | 2 | 272 | 95% | 7 |
| 34 | `bigint` | 4 | 276 | 96% | 4 |
| 35 | `call:arity` | 2 | 278 | 97% | 3 |
| 36 | `expr:assign` | 2 | 280 | 98% | 3 |
| 37 | `class:local` | 2 | 282 | 98% | 2 |
| 38 | `module:default` | 1 | 283 | 99% | 3 |
| 39 | `spread` | 1 | 284 | 99% | 1 |
| 40 | `generator` | 1 | 285 | 99% | 1 |
| 41 | `decorator` | 1 | 286 | 100% | 1 |
| 42 | `syntax` | 0 | 286 | 100% | 1 |
| 43 | `generic:class` | 1 | 287 | 100% | 1 |

## Named members inside the stdlib and module families (packages affected)

`stdlib:js`: Object.defineProperty 75; Set elements of type _ (Set elements must be string or numbe 51; a replacement value of this type (pass a string template or  45; Object.assign 40; new Set(...) 37; Object.getOwnPropertyNames 32; Object.keys 30; Object.getOwnPropertyDescriptor 28; Array.from with this argument shape 28; Object.getPrototypeOf 26; Set<any>.add 25; Set<any>.has 21; Number of unknown values 20; new RegExp with a  20; _ is part of the standard library types but has no scriptc l 17; Array.isArray 16; Object.freeze of a possibly-aliased value 16; new Map(...) 15; any[].reduce 15; .toString() 14

`stdlib:node`: require.resolve 28; Error.captureStackTrace 11; process.version 8; util.inherits 8; new TextDecoder 7; process.versions 7; path.parse 6; new TextEncoder 6; Error.stackTraceLimit 5; new AbortController 5; tty.isatty 5; util.inspect 5; require.extensions 5; console.warn 5; console.log 4; Require.resolve 4; console.error 4; TextEncoder.encode 4; util.promisify 4; util.debuglog 4

`module:builtin`: node:process 4; process 1; vm 1; repl 1; node:v8 1

`module:form`: module namespace objects as first-class values (access _ mem 1

### Per file (supplementary)

The same greedy with each source file as the unit (an entry file or a file a site sits in; 7760 files, 1539 without a site; past-gate sites left out, and files seen only past the gate dropped). At package granularity nearly every package has a long tail of families, so this view separates the broad fixes from the rare ones.

| step | fix | files with the family | newly clean files | cumulative | % |
|---|---|---|---|---|---|
| 1 | `write:untyped` | 1590 | 728 | 2267 | 29% |
| 2 | `cjs:shape` | 934 | 403 | 2670 | 34% |
| 3 | `binding:blocked` | 313 | 313 | 2983 | 38% |
| 4 | `types:shape` | 669 | 288 | 3271 | 42% |
| 5 | `cjs:require` | 1157 | 252 | 3523 | 45% |
| 6 | `dyn:receiver` | 1088 | 244 | 3767 | 49% |
| 7 | `stdlib:js` | 1261 | 273 | 4040 | 52% |
| 8 | `es5:proto` | 1102 | 316 | 4356 | 56% |
| 9 | `module:ns` | 611 | 298 | 4654 | 60% |
| 10 | `obj:computed` | 823 | 286 | 4940 | 64% |
| 11 | `destructure` | 577 | 298 | 5238 | 68% |
| 12 | `bundler:interop` | 255 | 249 | 5487 | 71% |
| 13 | `fn:call-bind` | 463 | 208 | 5695 | 73% |
| 14 | `date` | 487 | 216 | 5911 | 76% |
| 15 | `builtin:value` | 385 | 181 | 6092 | 79% |
| 16 | `class:dyn` | 252 | 182 | 6274 | 81% |
| 17 | `op:any` | 376 | 175 | 6449 | 83% |
| 18 | `stdlib:node` | 262 | 139 | 6588 | 85% |
| 19 | `generic:fn` | 235 | 133 | 6721 | 87% |
| 20 | `fn:value` | 421 | 116 | 6837 | 88% |
| 21 | `class:local` | 243 | 207 | 7044 | 91% |
| 22 | `global:sniff` | 144 | 70 | 7114 | 92% |
| 23 | `var:hoist` | 164 | 71 | 7185 | 93% |
| 24 | `symbol` | 152 | 69 | 7254 | 93% |
| 25 | `export:mutable` | 61 | 57 | 7311 | 94% |
| 26 | `call:arity` | 95 | 52 | 7363 | 95% |
| 27 | `ts-emit:enum` | 56 | 41 | 7404 | 95% |
| 28 | `closure:capture` | 66 | 40 | 7444 | 96% |
| 29 | `other` | 102 | 43 | 7487 | 96% |
| 30 | `expr:assign` | 69 | 32 | 7519 | 97% |

## QuickJS embed estimate

Upper bound: 267 of 278 non-clean packages import only builtins the island shims, so a whole-package hand-off to the engine could load them. Builtins outside the shim list: {'vm': 7, 'http2': 3, 'repl': 1, 'cluster': 1}. Static clean today: 11.

Combined bound (static clean or engine-servable): 278 of 289.

Statement coverage across sweeps (double counts shared modules): 153601 of 657736 statements fenced (23%).

## Analyzer crashes by cause

| packages | entries | cause | where |
|---|---|---|---|
| 2 | 3 | Cannot read properties of undefined (reading '_') | lowerStmts (frontend/lowering/lower-stmts.js:119:21) |
| 2 | 2 | could not load <path> | loadProgram7 (frontend/program.js:176:15) |
| 2 | 4 | lowerer bug: union-typed receiver lowered to a non-union | lowerUnionProperty (frontend/lowering/lower-exprs.js:10106:1 |

- Cannot read properties of undefined (reading '_'): eslint-plugin-promise, webpack
- could not load <path>: @emotion/react, vue
- lowerer bug: union-typed receiver lowered to a non-union: less, sass

## Internal compiler errors (SC9001: the IR validator rejected what lowering produced)

| packages | sites | cause | examples |
|---|---|---|---|
| 8 | 31 | internal compiler error: assign to undeclared local/global "_" | chai, colors, dayjs, deepmerge, esbuild, path |
| 3 | 9 | internal compiler error: assign to immutable local "_" | babel-jest, jest, regenerator-runtime |
| 2 | 2 | internal compiler error: bare unitLit '_' outside a unionWrap | babel-jest, eslint-plugin-flowtype |
| 2 | 6 | internal compiler error: ternary must not be void | mkdirp, rollup-plugin-node-resolve |
| 1 | 137 | internal compiler error: call to undeclared function "_" | chai |
| 1 | 1 | internal compiler error: assignExpr to immutable local "_" | babel-jest |
| 1 | 1 | internal compiler error: local "_" has bare unit type undefinedT | babel-jest |
| 1 | 2 | internal compiler error: call N.bindCallbackInternalsN type dyn != return func | rxjs |
| 1 | 1 | internal compiler error: call N.fromEntries.N arg N: expected array, got dyn | eslint-plugin-jest |
| 1 | 1 | internal compiler error: return type is bare unit type nullT | eslint-plugin-flowtype |
| 1 | 1 | internal compiler error: closure over undeclared function "_" | esbuild |

## WasmGC emitter refusals (SC3001), first entry of each package only

| packages | sites | cause | examples |
|---|---|---|---|
| 6 | 6 | the wasm backend does not support this construct yet (libCall:dyn.hasKey) | @vue/test-utils, async, minimist, rollup-plugin-commonjs, source-map-support, zone.js |
| 2 | 2 | the wasm backend does not support this construct yet (fn:async:await-dyn) | rollup-plugin-typescript2, tsup |
| 1 | 1 | the wasm backend does not support this construct yet (expr:regexLit:annexb-extended-pattern-char) | npm-run-all |
| 1 | 1 | the wasm backend does not support this construct yet (libCall:fs.readFileSyncDyn) | dotenv |
| 1 | 1 | the wasm backend does not support this construct yet (libCall:dyn.this:suspending) | jasmine-core |

Families per non-clean package: median 7, 90th percentile 19, max 33.

Timeouts in: webpack

No result: @babel/cli (0 entries), sass (3 entries), react-scripts (0 entries), babel-runtime (0 entries), sinon-chai (1 entries), del-cli (0 entries), aws-sdk (0 entries, ENOENT: no such file or directory, open '/home/joe/.cache/tsinter-dl/survey/npm/aws-sdk/node_modules/aws-sdk/package.json'), jsdoc (0 entries)

## Lists

Clean: @babel/preset-react, @babel/preset-typescript, @commitlint/config-conventional, @rollup/plugin-json, @rollup/plugin-replace, @storybook/addon-actions, babel, babel-cli, gulp-rename, json-loader, tslint-config-prettier
