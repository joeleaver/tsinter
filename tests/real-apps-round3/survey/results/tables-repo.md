# Stratum B, TypeScript source repos

Packages: 106. clean: 1, deferred-only: 0, blocked: 104, dep-unavailable: 1, no-result: 0.

Partial analysis (at least one entry timed out or crashed): 3. Timed-out entries: 13. Analyzer crashes: 0. Process crashes: 0. Entries skipped on the time budget: 160.

Entries analyzed: 10039; stopped at the type-check gate: 7558 (75%). The past-gate pass re-lowered 7416 of them with checker errors ignored; 142 of those crashed or timed out (expected on programs that do not type-check; not counted as compiler bugs). Sites seen only there are counted as hard refusals and shown in the past-gate column.

Verdict breakdown by hard refusal (a build-time diagnostic or package-level fallback, not a deferred fence), top families:

| family | blocked packages |
|---|---|
| stdlib:js: ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Obj | 100 |
| types:shape: types with no static representation: unions with fields, intersections, recursive records, | 99 |
| tsc:missing-dep: unresolved import (dependency or generated file absent; survey artifact, not a language ga | 97 |
| stdlib:node: Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 94 |
| tsc:knock-on: type errors downstream of an unresolved import or lost ambient types (implicit any, missin | 94 |
| dyn:receiver: method calls, member reads, for-in, switch, spread on any/unknown receivers | 87 |
| write:untyped: writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member | 83 |
| other: uncategorized | 75 |
| generic:fn: generic methods and arrows in forms with no monomorphized home | 73 |
| tsc:dom: browser globals: no DOM lib (document, window, HTMLElement, fetch types) | 72 |

## Ranked families (packages affected)

Hard = packages with at least one build-time refusal or package-level fallback in the family. Reached = deferred fences on the entry path. Init = packages with an unconditional module-level site, which dies at load.

| # | family | packages | hard | init | past-gate only | sites | sites/pkg (median) |
|---|---|---|---|---|---|---|---|
| 1 | `types:shape` types with no static representation: unions with fields, intersections, recursive records, any-typed members | 100 | 74 | 99 | 25 | 29623 | 143 |
| 2 | `stdlib:js` ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Object.assign, new Set( | 100 | 59 | 100 | 41 | 7728 | 33 |
| 3 | `dep-edge` import of an npm package that is not compiled statically | 99 | 82 | 99 | 17 | 25013 | 203 |
| 4 | `tsc:missing-dep` unresolved import (dependency or generated file absent; survey artifact, not a language gap) | 98 | 98 | 98 | 0 | 40208 | 153 |
| 5 | `binding:blocked` reference to a binding whose declaration was refused or has no lowering (mostly knock-on sites) | 96 | 15 | 96 | 81 | 5605 | 26 |
| 6 | `stdlib:node` Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 95 | 52 | 94 | 42 | 3936 | 16 |
| 7 | `tsc:knock-on` type errors downstream of an unresolved import or lost ambient types (implicit any, missing property, assignab | 94 | 94 | 94 | 0 | 38337 | 217 |
| 8 | `write:untyped` writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member chains | 90 | 27 | 83 | 56 | 2046 | 13 |
| 9 | `dyn:receiver` method calls, member reads, for-in, switch, spread on any/unknown receivers | 88 | 34 | 87 | 53 | 5345 | 18 |
| 10 | `other` uncategorized | 78 | 23 | 75 | 52 | 1133 | 7 |
| 11 | `generic:fn` generic methods and arrows in forms with no monomorphized home | 75 | 29 | 73 | 44 | 2666 | 11 |
| 12 | `op:any` operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, truthiness coercions | 73 | 10 | 66 | 56 | 753 | 5 |
| 13 | `tsc:dom` browser globals: no DOM lib (document, window, HTMLElement, fetch types) | 72 | 72 | 72 | 0 | 11236 | 72 |
| 14 | `date` Date values | 72 | 9 | 64 | 55 | 1325 | 7 |
| 15 | `destructure` destructuring beyond typed record sources: absent fields, optional patterns, rest over dynamic values, catch b | 71 | 5 | 65 | 60 | 535 | 4 |
| 16 | `es5:proto` ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Object.create, setPrototypeOf, p | 67 | 10 | 64 | 54 | 442 | 2 |
| 17 | `tsc:ambient` name not found: usually an ambient .d.ts the tsconfig includes, which tsinter does not load unless imported, o | 66 | 66 | 66 | 0 | 7435 | 14 |
| 18 | `cjs:require` require() off top level, computed, or as a value; createRequire; import.meta | 62 | 18 | 62 | 44 | 383 | 3 |
| 19 | `error:shape` Error specifics: constructor options (cause), overriding Error methods, non-Error throws read as Error | 57 | 13 | 51 | 38 | 719 | 3 |
| 20 | `global:sniff` reads or typeof of undeclared globals (UMD define/module/self/window, build flags like ngDevMode, devtools hoo | 56 | 0 | 56 | 56 | 1044 | 8 |
| 21 | `fn:value` functions as values: optional/defaulted params, overloads, generics kept open | 54 | 8 | 49 | 41 | 277 | 3 |
| 22 | `module:form` module forms: require() of JSON, default/namespace import forms, re-exports from packages, export = / import = | 52 | 51 | 52 | 1 | 566 | 5 |
| 23 | `container:elem` Map/Set/array element types outside the supported kinds | 52 | 13 | 52 | 39 | 285 | 3 |
| 24 | `tsc:jsx` JSX / React types (no JSX config is adopted) | 47 | 47 | 47 | 0 | 26424 | 468 |
| 25 | `module:default` default exports and default imports (SC1012) | 47 | 47 | 47 | 0 | 1575 | 10 |
| 26 | `fn:call-bind` Function.prototype.call/apply/bind and `arguments` on compiled functions | 45 | 11 | 38 | 27 | 169 | 2 |
| 27 | `class:dyn` class objects used dynamically: statics via a class value, extending builtins as values | 42 | 7 | 39 | 32 | 308 | 2 |
| 28 | `module:cycle` import cycles (SC1016) and require() below code that reaches its binding (SC1013) | 41 | 41 | 41 | 0 | 792 | 7 |
| 29 | `types:narrow` narrowing forms: hand-written type predicates, ?? that changes the result type, tuple/string index shapes | 39 | 6 | 34 | 28 | 683 | 5 |
| 30 | `spread` spreads beyond same-shape arrays and one-property conditional object spreads | 39 | 6 | 37 | 31 | 242 | 3 |
| 31 | `module:builtin` Node builtin module with no support (SC1010, node:* import fences) | 37 | 37 | 37 | 0 | 160 | 2 |
| 32 | `in:computed` `in` / hasOwnProperty with computed keys, dyn.hasKey | 35 | 2 | 30 | 28 | 135 | 2 |
| 33 | `generic:class` generic class hierarchies | 34 | 2 | 32 | 30 | 242 | 3 |
| 34 | `cfg:strict-off` tsconfig disables strictNullChecks (SC0002) | 30 | 30 | 30 | 0 | 73 | 1 |
| 35 | `symbol` symbol-keyed access outside class fields | 29 | 2 | 26 | 24 | 212 | 2 |
| 36 | `syntax` other syntax forms the frontend names as unsupported | 29 | 0 | 29 | 29 | 152 | 3 |
| 37 | `generator` async generators, generator methods, for-await beyond streams, .next(value) | 25 | 1 | 19 | 18 | 113 | 1 |
| 38 | `tsgo:panic` typescript-go checker panic (SC0004) | 23 | 6 | 20 | 14 | 82 | 2 |
| 39 | `expr:assign` assignments and side effects in expression position (x op= e as a value, void effectful, comma forms) | 22 | 4 | 19 | 15 | 110 | 3 |
| 40 | `obj:computed` runtime-keyed (computed-key) object literals holding methods, spreads, or non-scalar values | 22 | 5 | 20 | 15 | 44 | 1 |
| 41 | `bigint` bigint | 21 | 8 | 19 | 11 | 281 | 6 |
| 42 | `for:multi` multi-declarator `for (let i = 0, n = ...)` | 18 | 2 | 17 | 15 | 49 | 2 |
| 43 | `decorator` decorators (field, method, and generic class decorators) | 12 | 1 | 12 | 11 | 350 | 20 |
| 44 | `module:ns` module namespace objects as values; library functions as values | 11 | 3 | 8 | 5 | 22 | 1 |
| 45 | `esm-in-cjs` ES module syntax in a .ts/.js file Node would load as CommonJS (package has no "type": "module") | 9 | 9 | 9 | 0 | 915 | 28 |
| 46 | `class:local` classes declared inside functions, class expressions, mixins | 7 | 0 | 7 | 7 | 44 | 3 |
| 47 | `call:arity` calls omitting required parameters, optional-chaining on unusual values, delete | 7 | 0 | 7 | 7 | 16 | 1 |
| 48 | `cjs:shape` CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attached before reassign, table ent | 6 | 3 | 6 | 3 | 12 | 2 |
| 49 | `builtin:value` builtin globals, Math or string methods as values (#84) | 6 | 2 | 6 | 4 | 6 | 1 |
| 50 | `var:hoist` `var` read inside a hoisted function declared above it (generated parsers, bundles) | 2 | 0 | 2 | 2 | 4 | 2 |
| 51 | `typeof:static` typeof on statically typed values | 1 | 0 | 1 | 1 | 2 | 2 |

## Greedy unlock order

Population: 103 packages with a complete analysis (3 partial or empty results are left out; they cannot be called clean). A package counts as clean once every family it has is fixed. Each step takes the family that cleans the most packages; when none can finish a package, the one with the most leverage. `tsc:missing-dep` is the survey environment, so it is treated as already fixed; packages whose every entry stopped at preflight are left out, because nothing past the type check was seen.

### Every family, sites seen only past the type-check gate left out (the reliable view)

Population with at least one entry past preflight: 103. Clean at the start: 4.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `module:form` | 1 | 5 | 5% | 49 |
| 2 | `tsc:dom` | 0 | 5 | 5% | 70 |
| 3 | `types:shape` | 0 | 5 | 5% | 77 |
| 4 | `module:builtin` | 1 | 6 | 6% | 35 |
| 5 | `cjs:shape` | 1 | 7 | 7% | 3 |
| 6 | `tsc:jsx` | 0 | 7 | 7% | 47 |
| 7 | `cfg:strict-off` | 2 | 9 | 9% | 29 |
| 8 | `module:default` | 5 | 14 | 14% | 46 |
| 9 | `module:cycle` | 5 | 19 | 18% | 39 |
| 10 | `cjs:require` | 2 | 21 | 20% | 24 |
| 11 | `stdlib:node` | 1 | 22 | 21% | 62 |
| 12 | `other` | 1 | 23 | 22% | 42 |
| 13 | `stdlib:js` | 1 | 24 | 23% | 68 |
| 14 | `write:untyped` | 3 | 27 | 26% | 44 |
| 15 | `fn:value` | 3 | 30 | 29% | 17 |
| 16 | `dyn:receiver` | 2 | 32 | 31% | 51 |
| 17 | `generic:fn` | 3 | 35 | 34% | 34 |
| 18 | `op:any` | 3 | 38 | 37% | 27 |
| 19 | `error:shape` | 3 | 41 | 40% | 26 |
| 20 | `destructure` | 2 | 43 | 42% | 20 |
| 21 | `types:narrow` | 2 | 45 | 44% | 22 |
| 22 | `esm-in-cjs` | 2 | 47 | 46% | 8 |
| 23 | `in:computed` | 3 | 50 | 49% | 10 |
| 24 | `expr:assign` | 2 | 52 | 50% | 8 |
| 25 | `date` | 1 | 53 | 51% | 31 |
| 26 | `fn:call-bind` | 4 | 57 | 55% | 18 |
| 27 | `es5:proto` | 6 | 63 | 61% | 17 |
| 28 | `class:dyn` | 4 | 67 | 65% | 11 |
| 29 | `container:elem` | 2 | 69 | 67% | 14 |
| 30 | `bigint` | 3 | 72 | 70% | 12 |
| 31 | `module:ns` | 3 | 75 | 73% | 7 |
| 32 | `spread` | 2 | 77 | 75% | 11 |
| 33 | `generator` | 3 | 80 | 78% | 8 |
| 34 | `tsgo:panic` | 5 | 85 | 83% | 9 |
| 35 | `for:multi` | 4 | 89 | 86% | 5 |
| 36 | `generic:class` | 3 | 92 | 89% | 7 |
| 37 | `obj:computed` | 3 | 95 | 92% | 7 |
| 38 | `symbol` | 5 | 100 | 97% | 6 |
| 39 | `builtin:value` | 2 | 102 | 99% | 2 |
| 40 | `decorator` | 1 | 103 | 100% | 1 |

### Every family, past-gate sites included (types degraded by missing dependencies inflate types:shape)

Population with at least one entry past preflight: 103. Clean at the start: 2.

| step | fix | newly clean | cumulative clean | % | packages touched |
|---|---|---|---|---|---|
| 1 | `stdlib:js` | 0 | 2 | 2% | 97 |
| 2 | `fn:call-bind` | 1 | 3 | 3% | 43 |
| 3 | `types:shape` | 0 | 3 | 3% | 97 |
| 4 | `stdlib:node` | 0 | 3 | 3% | 92 |
| 5 | `write:untyped` | 0 | 3 | 3% | 87 |
| 6 | `module:form` | 1 | 4 | 4% | 50 |
| 7 | `generic:class` | 1 | 5 | 5% | 33 |
| 8 | `dyn:receiver` | 0 | 5 | 5% | 85 |
| 9 | `date` | 1 | 6 | 6% | 69 |
| 10 | `op:any` | 0 | 6 | 6% | 71 |
| 11 | `generic:fn` | 1 | 7 | 7% | 72 |
| 12 | `destructure` | 1 | 8 | 8% | 69 |
| 13 | `other` | 0 | 8 | 8% | 75 |
| 14 | `tsc:dom` | 0 | 8 | 8% | 70 |
| 15 | `cjs:require` | 0 | 8 | 8% | 60 |
| 16 | `global:sniff` | 1 | 9 | 9% | 56 |
| 17 | `module:builtin` | 1 | 10 | 10% | 35 |
| 18 | `module:ns` | 1 | 11 | 11% | 11 |
| 19 | `es5:proto` | 0 | 11 | 11% | 64 |
| 20 | `container:elem` | 1 | 12 | 12% | 50 |
| 21 | `esm-in-cjs` | 1 | 13 | 13% | 8 |
| 22 | `tsc:jsx` | 0 | 13 | 13% | 47 |
| 23 | `syntax` | 1 | 14 | 14% | 29 |
| 24 | `module:default` | 2 | 16 | 16% | 46 |
| 25 | `fn:value` | 2 | 18 | 17% | 53 |
| 26 | `class:dyn` | 3 | 21 | 20% | 40 |
| 27 | `error:shape` | 2 | 23 | 22% | 54 |
| 28 | `cfg:strict-off` | 1 | 24 | 23% | 29 |
| 29 | `in:computed` | 2 | 26 | 25% | 35 |
| 30 | `module:cycle` | 1 | 27 | 26% | 39 |
| 31 | `decorator` | 5 | 32 | 31% | 11 |
| 32 | `cjs:shape` | 4 | 36 | 35% | 6 |
| 33 | `obj:computed` | 2 | 38 | 37% | 21 |
| 34 | `expr:assign` | 2 | 40 | 39% | 21 |
| 35 | `symbol` | 2 | 42 | 41% | 27 |
| 36 | `types:narrow` | 3 | 45 | 44% | 39 |
| 37 | `spread` | 5 | 50 | 49% | 38 |
| 38 | `tsgo:panic` | 6 | 56 | 54% | 22 |
| 39 | `generator` | 8 | 64 | 62% | 24 |
| 40 | `bigint` | 9 | 73 | 71% | 21 |
| 41 | `for:multi` | 11 | 84 | 82% | 17 |
| 42 | `class:local` | 5 | 89 | 86% | 7 |
| 43 | `call:arity` | 6 | 95 | 92% | 7 |
| 44 | `builtin:value` | 5 | 100 | 97% | 6 |
| 45 | `var:hoist` | 2 | 102 | 99% | 2 |
| 46 | `typeof:static` | 1 | 103 | 100% | 1 |

## Named members inside the stdlib and module families (packages affected)

`stdlib:js`: _ is part of the standard library types but has no scriptc l 18; .toString() 18; new WeakMap 17; Array.from with this argument shape 15; Object.assign 13; import() 13; Number.parseInt 13; string[].unshift 12; new Set(...) 12; string.codePointAt 11; Object.freeze of a possibly-aliased value 11; String.fromCodePoint 10; Object.hasOwn 10; .startsWith with 2 arguments on strings 10; readdir with 2 arguments 9; writeFile with 3 arguments 9; for-of over tuples 9; Set elements of type _ (Set elements must be string or numbe 9; RegExpExecArray.index 8; new WeakSet 7

`stdlib:node`: ImportMeta.url 17; fs.renameSync 10; _ is typed by @types/node but has no scriptc lowering yet 8; ImportMeta.dirname 7; ParsedPath.root 6; fs/promises.lstat 6; URL.origin 6; URL.username 6; new AbortController 6; AbortController.abort 6; Require.resolve 5; Stats.mode 5; Hash.digest 5; process 5; require.resolve 5; Request 5; fs/promises.realpath 5; fs/promises.rename 5; ChildProcess.once 5; new TextDecoder 5

`module:builtin`: node:process 12; node:vm 6; node:dns/promises 6; vm 5; node:v8 4; console 4; node:console 3; process 2; inspector 2; node:readline/promises 2; node:sqlite 2; the _ import (it resolves only to type declarations — there  1; node:stream/web 1; dns/promises 1; node:constants 1; constants 1

`module:form`: re-exports from packages or builtin modules are not supporte 33; named imports from JSON modules are not supported yet 12; export = assignments are not supported yet 6; import = require(...) assignments are not supported yet 6; namespace imports (* as ns) are not supported yet 3; export = 2; require() destructuring with defaults, rest, or nested patte 1; module namespace objects as first-class values (access _ mem 1; namespace imports of JSON modules are not supported yet 1; namespace re-exports (export * as ns) of this module form ar 1; namespace imports of CommonJS modules are not supported yet 1

### Per file (supplementary)

The same greedy with each source file as the unit (an entry file or a file a site sits in; 16044 files, 8806 without a site; past-gate sites left out, and files seen only past the gate dropped). At package granularity nearly every package has a long tail of families, so this view separates the broad fixes from the rare ones.

| step | fix | files with the family | newly clean files | cumulative | % |
|---|---|---|---|---|---|
| 1 | `tsc:dom` | 1731 | 1412 | 10218 | 64% |
| 2 | `tsc:jsx` | 1832 | 1585 | 11803 | 74% |
| 3 | `esm-in-cjs` | 912 | 831 | 12634 | 79% |
| 4 | `module:default` | 616 | 517 | 13151 | 82% |
| 5 | `module:cycle` | 515 | 502 | 13653 | 85% |
| 6 | `types:shape` | 1011 | 492 | 14145 | 88% |
| 7 | `module:form` | 339 | 332 | 14477 | 90% |
| 8 | `stdlib:js` | 675 | 239 | 14716 | 92% |
| 9 | `stdlib:node` | 378 | 171 | 14887 | 93% |
| 10 | `dyn:receiver` | 305 | 117 | 15004 | 94% |
| 11 | `generic:fn` | 138 | 115 | 15119 | 94% |
| 12 | `module:builtin` | 114 | 102 | 15221 | 95% |
| 13 | `date` | 131 | 102 | 15323 | 96% |
| 14 | `other` | 140 | 72 | 15395 | 96% |
| 15 | `write:untyped` | 131 | 76 | 15471 | 96% |
| 16 | `cfg:strict-off` | 72 | 72 | 15543 | 97% |
| 17 | `error:shape` | 76 | 60 | 15603 | 97% |
| 18 | `types:narrow` | 76 | 56 | 15659 | 98% |
| 19 | `op:any` | 57 | 40 | 15699 | 98% |
| 20 | `cjs:require` | 44 | 38 | 15737 | 98% |
| 21 | `bigint` | 35 | 25 | 15762 | 98% |
| 22 | `container:elem` | 32 | 22 | 15784 | 98% |
| 23 | `destructure` | 29 | 23 | 15807 | 99% |
| 24 | `fn:call-bind` | 30 | 23 | 15830 | 99% |
| 25 | `class:dyn` | 24 | 23 | 15853 | 99% |
| 26 | `spread` | 28 | 21 | 15874 | 99% |
| 27 | `tsgo:panic` | 23 | 21 | 15895 | 99% |
| 28 | `fn:value` | 21 | 20 | 15915 | 99% |
| 29 | `es5:proto` | 23 | 20 | 15935 | 99% |
| 30 | `generic:class` | 19 | 19 | 15954 | 99% |

## Analyzer crashes by cause

None.

## Internal compiler errors (SC9001: the IR validator rejected what lowering produced)

None.

## WasmGC emitter refusals (SC3001), first entry of each package only

None.

Families per non-clean package: median 22, 90th percentile 31, max 36.

Timeouts in: babel/babel, google-gemini/gemini-cli, hoppscotch/hoppscotch

## Lists

Clean: standard/eslint-config-standard
