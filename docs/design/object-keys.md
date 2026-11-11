# Object keys in Set, Map, WeakMap and WeakSet (WasmGC lanes)

Status: design note, 2026-11-11, written against main `7aff51dd`. Scope: the `wasm` and
`wasm-native` lanes. The c and llvm lanes keep their string/number fence; they are ungated
and retire at N4.

## Goal

Set elements and Map keys may be any value, compared with SameValueZero as Node compares
them. Objects (records, class instances, arrays, functions, errors, maps and sets, dynamic
values) compare by identity. Primitives compare by value: NaN equals NaN, and -0 is stored
as +0. Iteration is insertion order. WeakMap and WeakSet take only object keys. Adjacent
pieces in the same unit: Map/Set/function Map values, and Set/Map as a union arm beside
`undefined`/`null` (for example `Set<AnalysisError> | undefined`).

## Representation

The container is unchanged (`maps.ts`: parallel dense arrays plus an open-addressing bucket
table). A key type picks one of these key kinds:

| key type | stored as | equality | hash |
|---|---|---|---|
| number, string, symbol | as today | as today | as today (**the fast path is untouched**) |
| boolean | i32 | `i32.eq` | the value (no slot, no layout change: outside the gate below) |
| any object type (record, class, array, function, error, Map/Set, regex, URL, handle...) | its own ref | `ref.eq` (functions: through the board-#89 identity unwrap, like `===`) | the object's identity hash |
| union | the union box | the union's SameValue OR strict equality (SameValueZero) | per arm: primitives by value, object arms by identity hash |
| `any` / `unknown` / `object` | the `$dyn` value | `svZero` (strict equality, NaN = NaN; views equal by token) | per kind: primitives by value, objects by identity hash, views by their token's |

`-0` is stored as `+0` for number keys, for a union's number arm and for a dynamic number.

**Identity hash.** This is a lazily assigned `i32` slot (`idh`), read on first use as a key.
A zero slot takes the next value of a global counter, so the hash is O(1) and stable. The slot
lives in:

- records: a trailing field;
- user-rooted class instances: a prefix field after `vt`, inherited by every subclass;
- arrays: the vector struct's trailing field;
- errors: the `errT` tail, after the GH #146 encoding slot;
- dynamic objects (`$dynObj`): a trailing field;
- Maps and Sets: a trailing field.

Records, classes, arrays, errors, dynamic objects and maps carry the slot **only in a module that
has an identity-keyed container** (any Map/Set/WeakMap/WeakSet whose key type is not a
number, string, boolean or symbol). Every other program's layout and code are byte-identical
to before, errors included (errT and its subtypes take the slot under the same gate).
Boolean keys use their own one-instruction helpers and never trigger the gate. Slotted
record and vector structs are interned apart from plain structs of the same layout
(`ModuleBuilder.idSlotStructType`), so the struct.new zero for the slot is never spliced into
an unrelated struct.new.

Closures, regexes, URLs, typed arrays, promises, class objects and runtime handles get no
slot. They hash to one constant, which is correct but O(n) per operation for those kinds.
They are rare as keys.

## Identity rules (the consistency hunt)

- **A record and its view are one key.** A view's identity is its token, the static value
  (S115 (a)). A dynamic key that is a view hashes through the token's slot, selected by the
  view's interned type id (one `br_table`, O(1)). Its equality is `strictEq`'s token
  compare. A typed key and a dynamic key never meet in one container: the key type fixes
  the representation. At the boundary, the existing crossings hand back the same object
  (unview, the error identity cache), or a copy that width-copies judges.
- **Width and dynamic copies.** A Map/Set operation whose key type is a composite counts as
  an identity test in `width-copies.ts` (S125 (b)), just like `===` and `includes`. A copy
  that could reach such a container refuses by name. Dynamic-keyed containers were already
  identity observers (U1a).
- **Errors** hash through `errT`'s slot. A dynamic error is its one encoding (GH #146), so
  it hashes as that dynamic object.
- **Hash collisions are always safe.** Equality decides membership, and a copy that happens
  to copy the slot only collides.

## WeakMap / WeakSet

These are typed as the same IR `map`/`set` with `weak: true`, which `typeKey` and
`typeEquals` distinguish, on the same storage. The table is strong. Nothing can observe
the difference: there is no iteration or size, and GC timing is invisible. TypeScript
already rules out primitive keys for a typed key. A dynamic key that is not an object
throws Node's TypeError (`Invalid value used as weak map key` / `Invalid value used in weak
set`) from `set`/`add`. `get`/`has`/`delete` answer `undefined`/`false`, as in Node. Inspect
prints `WeakMap { <items unknown> }` / `WeakSet { <items unknown> }`.

## Performance

String- and number-keyed maps run exactly the code they ran before. A program without an
identity-keyed container has an unchanged layout. With one, every record, array, class
instance and dynamic object is 4 bytes larger, and the allocation writes one zero. This is
measured by the perf row in `wasm-objkey-collections.test.ts` and the scaling row, which
covers 10k and 40k object keys and must stay linear.
