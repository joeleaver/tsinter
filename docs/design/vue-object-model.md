# Vue 2's object model: declared classes over a dynamic implementation (design)

Status: approved 2026-11-15 (D1–D3 ruled yes); built as described below. Driven by Vue 2.7 (top-10). Joe's ruling (2026-11-15): a
`declare class` in the program's own sources, with no class body anywhere, maps to the dynamic value — the doctrine
already approved for zod's declared interfaces over a dynamic implementation.

## The shape in Vue

- `src/types/component.ts` (a `.ts` source, not a `.d.ts`): `export declare class Component { constructor(options?:
  any); static cid: number; static options: …; static extend: GlobalAPI['extend']; … $el: any; $data: …; _init(…):
  void; … }`. No class body exists anywhere; the declaration is a type.
- `src/core/instance/index.ts`: `function Vue(options) { if (__DEV__ && !(this instanceof Vue)) warn(…);
  this._init(options) }`, then `initMixin(Vue)`, `stateMixin(Vue)`, `eventsMixin(Vue)`, `lifecycleMixin(Vue)`,
  `renderMixin(Vue)` (each `//@ts-expect-error Vue has function type`), then `export default Vue as unknown as
  GlobalAPI`.
- Each mixin takes `Vue: typeof Component` and writes the prototype:
  `Vue.prototype._init = function (options) { const vm: Component = this; vm._uid = uid++; … }`.
- `src/core/global-api/*` writes statics on the function (`Vue.cid = 0`, `Vue.use = …`, `Vue.options =
  Object.create(null)`), and `Vue.extend` builds subclasses at run time:
  `Sub.prototype = Object.create(Super.prototype); Sub.prototype.constructor = Sub; Sub['super'] = Super`.
- `GlobalAPI` (`src/types/global-api.ts`) is an interface with a call signature (`(options?: any): void`) plus the
  statics.

Diagnostics this removes, from the 340 in the last vue build:
- 28 prototype and static writes (the "assignment to non-variables" group, part 1a);
- SC1080 `'this' outside a class method`, 10;
- reading `prototype` from `typeof Component`;
- `GlobalAPI.prototype`, 6;
- `'(any) => void' values where 'typeof Component' is expected` (the mixin calls), 5;
- probably the 4 "constructing through a class value with no lowering".

## What already exists (U3+U4, main) — reused, not duplicated

`docs/design/dynamic-values.md` §4.6, "U3 + U4 as built" (`backend/wasm/objmodel.ts`,
`frontend/lowering/lower-objmodel.ts`), gives JavaScript sources all of the runtime this needs:
- a function's own property table (`$fnProps` enumT/hidT, S062);
- a lazy `prototype` with a non-enumerable `constructor`;
- `new F(…)` per ordinary [[Construct]] (a linked OBJ over `F.prototype`; an object result kept);
- prototype-chain reads and `instanceof`;
- `call`/`apply`/`bind` with `this`;
- `Object.create` / `setPrototypeOf` / `defineProperty`;
- `this` in a plain function as the ambient receiver (`dyn.this`), bound by dynamic method dispatch, `new`,
  `call` and `apply`.

The ES5 analysis (`collectEs5`) decides which JavaScript functions are dynamic constructors (newed, `.prototype`
touched, `call`/`apply`/`bind` read, an `Object.*` target). `Lowerer.typeOf` answers `any` for them and their
instances. A reference lowers to the function's FUNC box (`lowerEs5Ref`).

What stops Vue is only that every one of these gates is **JavaScript-source only**, plus the type side: a
body-less `declare class` has no mapping.

## Design

### (A) The type: declared-dynamic classes

A class symbol is *declared-dynamic* when all of these hold:
- every declaration is a `declare class` (ambient), or an interface merged with one;
- each declaration sits in a program source file (not the TypeScript lib, not `@types`, not an npm package's
  `.d.ts`; those keep S133);
- no declaration has a body.

Its instance type and `typeof C` map to the dynamic value (`JSVAL` under sharedDynamic, `DYN` otherwise) in
`frontend/types.ts`, next to the `Function` rule. Every use is then the existing dynamic machinery:
- member reads, writes and calls;
- `new C(…)` on a dynamic value;
- `C.prototype`;
- `instanceof C`.

`GlobalAPI`-style interfaces need a decision (see Decisions, D1). Rule A2 (proposed): a program-source interface
with a call or construct signature whose members mention a declared-dynamic class maps to the dynamic value too.
A callable object is something only the dynamic world can hold. The narrower alternative is to leave it to the
`as unknown as GlobalAPI` cast site.

### (B) The values: TypeScript functions as dynamic constructors

`collectEs5` runs over TypeScript sources too, with the same triggers (newed, `.prototype` touched,
`call`/`apply`/`bind` read, an `Object.*` target), plus one TypeScript trigger: the function value reaches a slot
typed by a declared-dynamic class. That covers:
- an argument to a parameter typed `typeof C` or `C` (the mixin calls, `@ts-expect-error`'d or not);
- a cast `F as unknown as T` where T is declared-dynamic or a rule-A2 interface;
- an assignment into such a binding.

The same products follow:
- `Lowerer.typeOf` answers `any` for the function and its instances;
- a reference lowers to the FUNC box (`lowerEs5Ref`), so `Vue`, `Vue.prototype` and `Vue === Sub.super` see one
  value;
- `new Vue(…)` is U4's [[Construct]].

Generators stay out (a generator is never a constructor; the Function unit's change).

### (C) `this` in TypeScript plain functions

Today a plain function's `this` in a TypeScript source is SC1080 (`lower-exprs.ts`, the `ThisKeyword` arm). It
becomes the ambient receiver (`dyn.this`, as in JavaScript sources) when either holds:
- the checker types that `this` as `any` (`noImplicitThis: false`, Vue's tsconfig);
- the `this` is typed by a declared-dynamic class.

An explicitly typed `this: T` parameter keeps today's lowering, and so does a `this` inside a class or object
method. Binding is U4's: `vm._init(options)` on a dynamic object binds `vm`; `new`, `call`, `apply` and `bind` bind
their receiver. A plain call binds `undefined`, the strict-mode answer. Vue's sources are ES modules, so strict.

`const vm: Component = this` is then a dynamic value flowing into a dynamic slot: no conversion.

### (D) Writes and statics

These need nothing new once (A)–(C) hold:
- `Vue.prototype.x = f` is a dynamic keyed write on the FUNC box's lazy `prototype`;
- `Vue.cid = 0` is a write to the function's own table;
- `Sub.prototype = Object.create(Super.prototype)` is U3's `create` plus U4's mutable proto;
- `Sub['super'] = Super` is a keyed write.

A TypeScript function expression written to a prototype crosses into dynamic code as the Function unit's box. Its
`this` is (C).

### (E) Typed code meeting the dynamic world

Vue's typed classes (VNode, Dep, Watcher, EffectScope) stay compiled. Fields typed `Component` become dynamic
slots (S128's containment). A typed function receiving `vm: Component` gets a dynamic parameter.

What can still refuse is any typed construct that the dynamic path does not serve yet. It refuses loudly at its
site, never as a fallback.

## Gate and cost

- The rules fire only in a program with a body-less program-source `declare class`, or a TypeScript function
  meeting a (B) trigger. Every other program is byte-identical: the U3+U4 `objModelLive` gate stays the switch.
- Vue's instance world (every `vm.*` read, `$emit`, render helpers) runs on dynamic objects. It is slower than
  typed structs. It is exact to Node by construction.

## SEMANTICS

No new entry is expected: dynamic values behave as Node's. Any difference the rows find gets registered first,
or refused by name.

## Rows (both lanes, against Node)

1. A `declare class C` with statics and methods, implemented by `function C(o) { this._init(o) }`, with mixins
   writing `C.prototype.*` through a `typeof C` parameter. Covers `new C(…)`, method calls, `instanceof`,
   `this.x` writes, and inspect output.
2. Statics: `C.cid = 0`, `C.use = function (p) { … return this }`, chained `C.use(a).use(b)`.
3. `C.extend`: `Sub.prototype = Object.create(Super.prototype)`, `constructor` and `super` links, instances of
   `Sub` reading `Super`'s prototype methods, and `instanceof` both ways.
4. `export default C as unknown as API`, where API is an interface with a call signature (rule A2), used from
   another module.
5. Implicit-any `this` in a TypeScript function expression under `noImplicitThis: false`, called as a method,
   through `call`/`apply`/`bind`, and plainly (`undefined`).
6. A typed class (VNode-like) holding a `Component` field, and typed code reading it.
7. Negative rows: an explicitly typed `this: Foo` keeps its lowering, and a generator stays a stand-in.

Then re-run vue (alone, `timeout 1800`) and regroup what is left.

## Rulings (2026-11-15)

- D1 yes: a program-declared callable interface (call signatures plus members of its own, merged with no class)
  maps to the dynamic value. An interface with only a call signature stays a function type.
- D2 yes: in any `noImplicitThis: false` project, an implicit-any `this` in a plain function is the ambient
  receiver. That is Node's semantics, not a divergence.
- D3 yes: `@ts-expect-error`'d mixin calls count as (B) triggers; the call runs at run time regardless.
- No SEMANTICS entry unless a part cannot be exact.
