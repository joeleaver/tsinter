A = 294 npm packages, B = 106 TypeScript repos

| family | A pkgs | A % | A sites | B repos | B % | + B past-gate only | B sites |
|---|---|---|---|---|---|---|---|
| `dep-edge` import of an npm package that is not compiled statically | 150 | 51% | 9307 | 84 | 79% | 15 | 25013 |
| `stdlib:js` ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(r | 182 | 62% | 6024 | 70 | 66% | 30 | 7728 |
| `types:shape` types with no static representation: unions with fields, intersections, recursiv | 133 | 45% | 2594 | 79 | 75% | 21 | 29623 |
| `dyn:receiver` method calls, member reads, for-in, switch, spread on any/unknown receivers | 182 | 62% | 7595 | 52 | 49% | 36 | 5345 |
| `binding:blocked` reference to a binding whose declaration was refused or has no lowering (mostly  | 189 | 64% | 10131 | 39 | 37% | 57 | 5605 |
| `write:untyped` writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound | 166 | 56% | 6900 | 45 | 42% | 45 | 2046 |
| `stdlib:node` Node API member with no lowering (path.parse, process.*, fs.*, stream.*) | 110 | 37% | 745 | 64 | 60% | 31 | 3936 |
| `tsc:missing-dep` unresolved import (dependency or generated file absent; survey artifact, not a l | 1 | 0% | 1 | 98 | 92% | 0 | 40208 |
| `tsc:knock-on` type errors downstream of an unresolved import or lost ambient types (implicit a | 0 | 0% | 0 | 94 | 89% | 0 | 38337 |
| `cjs:require` require() off top level, computed, or as a value; createRequire; import.meta | 134 | 46% | 3486 | 24 | 23% | 38 | 383 |
| `tsc:dom` browser globals: no DOM lib (document, window, HTMLElement, fetch types) | 0 | 0% | 0 | 72 | 68% | 0 | 11236 |
| `date` Date values | 108 | 37% | 1538 | 32 | 30% | 40 | 1325 |
| `tsc:ambient` name not found: usually an ambient .d.ts the tsconfig includes, which tsinter do | 0 | 0% | 0 | 66 | 62% | 0 | 7435 |
| `es5:proto` ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Ob | 132 | 45% | 5624 | 18 | 17% | 49 | 442 |
| `fn:call-bind` Function.prototype.call/apply/bind and `arguments` on compiled functions | 119 | 40% | 1229 | 19 | 18% | 26 | 169 |
| `other` uncategorized | 47 | 16% | 239 | 44 | 42% | 34 | 1133 |
| `op:any` operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, tr | 92 | 31% | 3461 | 27 | 25% | 46 | 753 |
| `destructure` destructuring beyond typed record sources: absent fields, optional patterns, res | 101 | 34% | 1374 | 21 | 20% | 50 | 535 |
| `module:form` module forms: require() of JSON, default/namespace import forms, re-exports from | 17 | 6% | 20 | 51 | 48% | 1 | 566 |
| `cjs:shape` CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attac | 134 | 46% | 1774 | 3 | 3% | 3 | 12 |
| `generic:fn` generic methods and arrows in forms with no monomorphized home | 44 | 15% | 475 | 35 | 33% | 40 | 2666 |
| `module:default` default exports and default imports (SC1012) | 4 | 1% | 4 | 47 | 44% | 0 | 1575 |
| `tsc:jsx` JSX / React types (no JSX config is adopted) | 0 | 0% | 0 | 47 | 44% | 0 | 26424 |
| `fn:value` functions as values: optional/defaulted params, overloads, generics kept open | 83 | 28% | 1490 | 17 | 16% | 37 | 277 |
| `module:cycle` import cycles (SC1016) and require() below code that reaches its binding (SC1013 | 12 | 4% | 25 | 41 | 39% | 0 | 792 |
| `module:builtin` Node builtin module with no support (SC1010, node:* import fences) | 17 | 6% | 30 | 37 | 35% | 0 | 160 |
| `obj:computed` runtime-keyed (computed-key) object literals holding methods, spreads, or non-sc | 90 | 31% | 2519 | 7 | 7% | 15 | 44 |
| `error:shape` Error specifics: constructor options (cause), overriding Error methods, non-Erro | 25 | 9% | 102 | 27 | 25% | 30 | 719 |
| `builtin:value` builtin globals, Math or string methods as values (#84) | 84 | 29% | 1610 | 2 | 2% | 4 | 6 |
| `class:dyn` class objects used dynamically: statics via a class value, extending builtins as | 59 | 20% | 623 | 11 | 10% | 31 | 308 |
| `cfg:strict-off` tsconfig disables strictNullChecks (SC0002) | 2 | 1% | 4 | 30 | 28% | 0 | 73 |
| `module:ns` module namespace objects as values; library functions as values | 63 | 21% | 1496 | 7 | 7% | 4 | 22 |
| `types:narrow` narrowing forms: hand-written type predicates, ?? that changes the result type,  | 5 | 2% | 10 | 22 | 21% | 17 | 683 |
| `symbol` symbol-keyed access outside class fields | 46 | 16% | 336 | 7 | 7% | 22 | 212 |
| `container:elem` Map/Set/array element types outside the supported kinds | 15 | 5% | 57 | 15 | 14% | 37 | 285 |
| `in:computed` `in` / hasOwnProperty with computed keys, dyn.hasKey | 28 | 10% | 87 | 10 | 9% | 25 | 135 |
| `global:sniff` reads or typeof of undeclared globals (UMD define/module/self/window, build flag | 54 | 18% | 1076 | 0 | 0% | 56 | 1044 |
| `var:hoist` `var` read inside a hoisted function declared above it (generated parsers, bundl | 53 | 18% | 3370 | 0 | 0% | 2 | 4 |
| `spread` spreads beyond same-shape arrays and one-property conditional object spreads | 16 | 5% | 24 | 11 | 10% | 28 | 242 |
| `bigint` bigint | 13 | 4% | 104 | 12 | 11% | 9 | 281 |
| `expr:assign` assignments and side effects in expression position (x op= e as a value, void ef | 21 | 7% | 430 | 9 | 8% | 13 | 110 |
| `generator` async generators, generator methods, for-await beyond streams, .next(value) | 10 | 3% | 50 | 9 | 8% | 16 | 113 |
| `tsgo:panic` typescript-go checker panic (SC0004) | 2 | 1% | 2 | 10 | 9% | 13 | 82 |
| `bundler:interop` bundler output: createRequire banners (node:module), __toESM interop helpers | 28 | 10% | 293 | 0 | 0% | 0 | 0 |
| `for:multi` multi-declarator `for (let i = 0, n = ...)` | 14 | 5% | 60 | 5 | 5% | 13 | 49 |
| `esm-in-cjs` ES module syntax in a .ts/.js file Node would load as CommonJS (package has no " | 0 | 0% | 0 | 9 | 8% | 0 | 915 |
| `ts-emit:enum` compiled TypeScript enums in shipped JS: E[E["A"] = 0] = "A" | 22 | 7% | 1472 | 0 | 0% | 0 | 0 |
| `generic:class` generic class hierarchies | 2 | 1% | 10 | 7 | 7% | 27 | 242 |
| `closure:capture` bindings captured through a plain nested function with no static storage | 20 | 7% | 539 | 0 | 0% | 0 | 0 |
| `call:arity` calls omitting required parameters, optional-chaining on unusual values, delete | 19 | 6% | 249 | 0 | 0% | 7 | 16 |
| `export:mutable` exporting a mutable binding by reference (live bindings) | 17 | 6% | 61 | 0 | 0% | 0 | 0 |
| `ice` internal compiler error (SC9001) | 15 | 5% | 192 | 0 | 0% | 0 | 0 |
| `class:local` classes declared inside functions, class expressions, mixins | 12 | 4% | 579 | 0 | 0% | 7 | 44 |
| `wasm:backend` lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entr | 11 | 4% | 11 | 0 | 0% | 0 | 0 |
| `syntax` other syntax forms the frontend names as unsupported | 4 | 1% | 33 | 0 | 0% | 29 | 152 |
| `decorator` decorators (field, method, and generic class decorators) | 1 | 0% | 1 | 1 | 1% | 11 | 350 |
| `typeof:static` typeof on statically typed values | 1 | 0% | 1 | 0 | 0% | 1 | 2 |
