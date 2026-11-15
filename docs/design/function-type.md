# TypeScript's global `Function` as a value type

Status: built (approved 2026-11-14).

## The problem

Vue's build reports `Function` everywhere: `Function[]`, `{ [k: string]: Function }`, `Function | undefined`
fields, and `(fn: Function, ctx: Object) => Function`. That is about 30 sites directly, and plausibly about 50
counting the declarations it blocks (`warn`, the vnode-hook records).

Today the lib's `Function` interface has no mapping. `types.ts` maps its siblings already:
- `Object` lowers to the dynamic value (DYN, line 1565), because tsc admits anything into it;
- `FunctionConstructor` lowers to JSVAL under the one-world lowering (S132, line 1558).

## Proposal: `Function` is the dynamic value

Map the lib's `Function` interface (provenance-checked, so a user's own `interface Function` keeps its own
mapping) to the dynamic value. That is JSVAL in the one-world lowering and DYN in JavaScript sources, exactly
the stance `Object` takes. This is sound for the same reason: tsc admits every callable, of any signature, into
a `Function` slot, and gives back only `any` when you call it, so no static signature exists to keep.

Everything else follows from existing machinery, with no new representation:
- **Composites.** `Function[]` becomes the dynamic array (a jsval element absorbs the array, types.ts's rule).
  `{ [k: string]: Function }` becomes an index-signature record with a dynamic value slot, or is absorbed, by the
  same rule. `Function | undefined` becomes the dynamic value, whose `undefined` is its own.
  `(fn: Function) => Function` becomes a function type whose parameter and result are dynamic.
- **Entering.**
  - A typed function value entering a `Function` slot boxes, as any function crossing into dynamic code does
    today (`classFuncBox`). Identity is one box per closure, so `f === g` holds as in Node. The name is the one
    S020 already governs.
  - `.length` follows Node: the parameters before the first default or rest, stamped from the definition (S020's
    amendment). A function with a rest parameter still cannot become a value; it refuses by name.
  - A signature the box cannot carry stops by name where it crosses, through the existing fence.
  - A JavaScript function with no compiled form (a generator) crosses as a stand-in that stops by name only when
    called. Its identity comes from its definition, which is resolved through:
    - the function in place;
    - a function declaration;
    - a const;
    - a let or var the program never rebinds;
    - import aliases, namespace-import members, and `export default`.

    Every crossing of one definition shares one stand-in, so `===` and properties hold as in Node, and the
    stand-in reports that definition's name, length and kind. The sharing applies only to a definition evaluated
    once per run: the module is its nearest enclosing function, and no loop encloses it. Each of the following
    stops by name where it crosses, rather than compare or share where Node would not:
    - a definition inside a function body, method, accessor, constructor, static block, instance field
      initializer or loop (a new object per evaluation in Node);
    - a definition this build cannot name (a property read, a rebound let, a run-time choice);
    - a stand-in's `name` or `length` redefined through `Object.defineProperty`. The stand-in reports facts stamped
      from its definition. An ordinary function's redefinition lands in its property table, which reads consult
      first, as in Node.
- **Using.**
  - Calling it (`fn(a, b)`) is the dynamic call the checker already types as `any`.
  - `fn.call(t, ...)`, `fn.apply(t, args)`, `fn.bind(t, ...)`, `fn.name` and `fn.length` are the dynamic function
    members the object model serves today (U3/U4, `om.*` and dyn FUNC).
  - `String(fn)` echoes a JavaScript definition's own source and stops by name otherwise (S019's amendment). A
    TypeScript function's text is not Node's, because Node strips its types; a cloning module's carried TypeScript
    text is flagged (`FN_PROTO_SRC_TS`).
  - `typeof fn === "function"` is the dynamic `typeof`.
  - What this removes: the "Function.prototype.call on a compiled function value" refusals (vue's
    `shared/util.ts` and `model.ts`) disappear at sites where the receiver is typed `Function`. A receiver with a
    real signature keeps its direct-call lowering.
- **Leaving.** A `Function` value flowing into a typed function slot (`f as (x: number) => void`, a typed
  parameter) takes the existing dynamic-to-function exit. A shape that exit cannot carry refuses by name.

## `Function` used as a value

Vue's 7 SC2020 sites turned out to be type annotations (`patch: Function`, `cb: Function`), which the mapping
covers. The value forms are not built:
- `x instanceof Function` is not built.
- `Function.prototype` and anything else on the constructor keep refusing by name. `new Function(...)` stays
  S132's EvalError.


## Not changed

- Function types with real signatures keep their static mapping and direct calls; only the lib's `Function`
  moves.
- No new SEMANTICS entry is expected: a dynamic value behaves as Node's function. If rows show a difference
  (`.length` of a boxed function with optional parameters, `toString` text), it gets registered before merge,
  or refused by name.

## Cost

Calls through a `Function`-typed value become dynamic calls, slower than a direct call. That applies only where
the program spells `Function`; typed callbacks are unaffected.

## Rows

Planned for both lanes against Node:
- `Function[]` push, iterate and call;
- `{ [k]: Function }` registry lookup and call (vue's `optionMergeStrategies`);
- `(fn: Function, ctx: Object) => Function`: vue's `bind` polyfill, `.call`/`.apply`/`.bind`, `.name`, `.length`;
- a typed function entering `Function` and leaving back into a typed slot;
- identity (`===`) through the box;
- `Function | undefined` optional fields;

Then re-probe vue to count what's left.
