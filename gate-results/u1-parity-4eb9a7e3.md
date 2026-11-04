# U1 parity: wasm census, `u1-shared-dynamic` @ 4eb9a7e3 vs `main` @ 2570365b

Run on 2026-11-04 in a cloud VM (4 vCPU) after `bash scripts/cloud-setup.sh` (Node v24.18.1, clang 21.1.8, pnpm 10). Each census: `cleanenv npx vitest run tests/harness/wasm-differential.test.ts --reporter=json --reporter=default` with `SCRIPTC_WASM_REFUSALS=1 SCRIPTC_TEST_WORKERS=4`. Both checkouts were built with `pnpm install --frozen-lockfile && pnpm build`. No source was changed.

## Counts

| run | claimed | (i) newly refused / fails to compile | (ii) newly wrong output or trap: **silent** | (ii) of which loud runtime fences | (iii) newly passing | vitest pass / fail / skip |
|---|---|---|---|---|---|---|
| main @ 2570365b | 1132/1135 | — | — | — | — | 1568 / 0 / 4 |
| 4eb9a7e3, full mapping (no `SCRIPTC_U1_STAGE`) | 1053/1135 | 101 (79 corpus + 22 harness rows) | **3** (3 corpus + 0 harness) | 120 (80 corpus + 40 harness) | 0 | 1344 / 224 / 4 |
| 4eb9a7e3, `SCRIPTC_U1_STAGE=world` | 1092/1135 | 55 (40 corpus + 15 harness rows) | **6** (4 corpus + 2 harness) | 95 (65 corpus + 30 harness) | 0 | 1414 / 154 / 4 |

How to read it:
- **claimed** is the census's own `wasm tier: N/1135` line. A program is claimed once it compiles; claimed programs can still fail on output, so they show up in (ii).
- **(i)** is a corpus program that was claimed and passing on main and now refuses with SC3001 or fails to compile with another diagnostic, plus non-corpus harness rows that now stop with `refused: …` at build time.
- **(ii)** is a test that compiles on both sides but whose run now differs from Node. I reran every (ii) program with a temporary, uncommitted copy of the harness that also records the wasm stderr and exit code, and split (ii) in two:
  - **silent**: wrong output or a trap with no diagnostic. These are the miscompiles.
  - **loud runtime fence**: the module compiles, runs, and stops at the construct with `tsinter: unsupported: … [SCnnnn at file:line]` on stderr and exit 1. Its stdout is a prefix of Node's (often empty). These are named, but they fire at run time, not compile time, so the census counts them as claimed.
- Harness rows named `*-C-NNNN` (for example `N1-C-1797`) run the corpus program NNNN again under that suite's own checks, so the same program can be counted once as a corpus row and once as a harness row.
- Ignored rows (known environmental/flaky): no-IPv6 skips (the 4 skips, identical on all three runs), #123 (U4-R-10 / SECURITY 2-3 `--use-system-ca` text, which did not occur here), #124 U3-ORD-01/U3-BIG-01, #116 O23-B1. Ignored in these runs: full: `U3-BIG-01`; world: none. U3-BIG-01 failed with its known stdout reordering.
- `tier floor: EXACTLY the claimed set` fails in both branch runs. That is expected: it mirrors the claimed-set drop and is not counted above.
- The runtime fences are not silent, but they are not compile-time refusals either: a claimed program runs part of the way and then stops with an SC diagnostic at run time. The census counts them as claimed and as failures. Whether that shape is acceptable for U1 is a call for the lead. This report only counts them separately.
- Main's work queue: `wasm work queue (2 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3`.

## Silent miscompiles (the (ii) items that matter)

### `1664-dyn-fn-boundary.cjs` (full + world)

Function **name lost** when a named typed function crosses into a dyn/jsval slot and is shown with `util.inspect` (`inspect(pass(add))`, `inspect(pass(function named(){}))`): Node `[Function: add]`, wasm `[Function (anonymous)]`. Exit 0 both, no stderr.

```diff
@@ stdout line 9 @@
- [Function: add]
+ [Function (anonymous)]
```

### `1667-dyn-fn-not-callable.cjs` (full + world)

Calling a non-function dyn value (`const num = pass(42); num(1)`): the caught TypeError's message names the callee as `value` instead of the source expression (`num`). Exit 1 both (the program's own uncaught tail), so only stdout differs.

```diff
@@ stdout line 1 @@
- caught: num is not a function
+ caught: value is not a function
```

### `2602-dyn-array-destructure.js` (full)

Array destructuring of a non-iterable dyn value (`const bad = JSON.parse('5'); const [z] = bad;`): the caught TypeError message is the runtime's `number 5 is not iterable (cannot read property Symbol(Symbol.iterator))`, not V8's `bad is not iterable`. Exit 0 both.

```diff
@@ stdout line 11 @@
- caught: bad is not iterable
+ caught: number 5 is not iterable (cannot read property Symbol(Symbol.iterator))
```

### `2639-http-dyn-req-pause.cjs` (world)

**Trap with no diagnostic.** Exit 1, empty stderr, empty stdout. The request/data listeners are wrapped as `function(){ return fn.apply(this, arguments) }` and the program dies before its first output line, which Node prints from inside the first `'data'` callback. Under the full mapping this program stops at a loud fence instead (`request handlers with more than two parameters`).

```diff
@@ stdout line 1 @@
- pausing after first chunk: true
+ 
```

### `2640-net-dyn-socket-compat.cjs` (world)

**Trap with no diagnostic.** Exit 1, empty stderr; stdout stops after `finish cb`. The next line Node prints, `pause returns c: true`, comes from the client's `'data'` listener, which is wrapped in the same `fn.apply(this, arguments)` shape. Under the full mapping this program stops at a loud fence instead (`connection handlers with more than 1 parameter`).

```diff
@@ stdout line 5 @@
- pause returns c: true
+ 
```

The harness rows `N1-C-2640 (world)`, `N2-C-2639 (world)` are these same programs run again under their suite's checks, and fail the same way (exit 1, empty stderr).


---

## Run: 4eb9a7e3, full mapping (no `SCRIPTC_U1_STAGE`)

- `wasm tier: 1053/1135 corpus programs claimed; first refusals: module:embedded×3, expr:jsOp×2`
- `wasm work queue (3 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3, expr:jsOp×2`

### (ii) Output differences / traps: 123 (3 silent, 120 loud runtime fences)

**Silent (3):** `1664-dyn-fn-boundary.cjs`, `1667-dyn-fn-not-callable.cjs`, `2602-dyn-array-destructure.js`. Details are in the section above.

**Loud runtime fences (120).** Expected = Node's first stdout line that is missing or different. Actual = the wasm line (`∅` means stdout ends there). Exit is wasm/Node (harness rows: wasm only). The construct is the fence's own message.

| test | exit | expected (Node) | actual (wasm) | construct (fence message) |
|---|---|---|---|---|
| `1608-cjs-assert/main.js` | 1/0 | `cjs assertions passed` | ∅ | 'assert.deepStrictEqual of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.js:16] |
| `1612-cjs-module-globals.cjs` | 1/0 | `G1 string string` | ∅ | the builtin 'process' used as a value (it has no runtime object here — comparisons with another builtin, truthiness and builtin-only Set membership tests lower; read and call its members directly) is not supported yet [SC1090 at 1612-cjs-module-globals.cjs:8] |
| `1614-js-fence-dodges.cjs` | 1/0 | `F1 true` | ∅ | syntax 'BigIntLiteral' is not supported yet [SC1090 at 1614-js-fence-dodges.cjs:13] |
| `1615-cjs-export-shapes/main.cjs` | 1/0 | `T1 first` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at proxied.cjs:17] |
| `1643-metadata-dyn-return.cjs` | 1/0 | `[ '--expose-internals', '--no-warnings' ]` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `1665-dyn-fn-mustcall/main.cjs` | 1/0 | `done code=0 signal=none` | ∅ | passing 'unknown' values where '(any, any, any) => any' is expected is not supported yet [SC1100 at main.cjs:16] |
| `1668-dyn-fn-throws.cjs` | 1/1 | `call 1` | ∅ | passing 'unknown' values where '(any) => any' is expected is not supported yet [SC1100 at 1668-dyn-fn-throws.cjs:23] |
| `1678-emitter-dyn-listeners.cjs` | 1/0 | `arrow got 5 number` | ∅ | 'the event 'x' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1678-emitter-dyn-listeners.cjs:11] |
| `1679-console-dyn.js` | 1/0 | `[` | ∅ | values of type '(_: any, i: number) => number' have no static representation but run in the embedded dynamic engine, which this build does not include [SC2011 at 1679-console-dyn.js:23] |
| `1700-mustcall-common/main.cjs` | 1/0 | `onTwice 1 2` | ∅ | this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported) is not supported yet [SC1090 at common.cjs:57] |
| `1701-mustcall-exit-report/main.cjs` | 1/1 | `end of main` | ∅ | this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported) is not supported yet [SC1090 at common.cjs:57] |
| `1703-arguments-rest-props.cjs` | 1/0 | `n=0 first=undefined` | ∅ | values of type '() => string' cannot be compiled: the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity [SC2009 at 1703-arguments-rest-props.cjs:14] |
| `1710-cjs-export-class/main.js` | 1/0 | `dec → 2` | ∅ | increment/decrement of record fields or elements in expression position is not supported yet [SC1045 at countdown.js:20] |
| `1713-js-dyn-fields.js` | 1/0 | `take(2) → 3` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at 1713-js-dyn-fields.js:16] |
| `1730-countdown-symbol-keys/main.js` | 1/0 | `start: 3` | ∅ | passing 'unknown' values where '(any, any, any) => any' is expected is not supported yet [SC1100 at countdown.js:13] |
| `1731-symbol-field-shapes.cjs` | 1/0 | `bump -> 7` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at 1731-symbol-field-shapes.cjs:27] |
| `1732-symbol-field-cross-module/main.js` | 1/0 | `tick -> 8` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at timer.js:14] |
| `1745-stream-encoding-js.cjs` | 1/0 | `plain len: 3 first byte: 120` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1745-stream-encoding-js.cjs:10] |
| `1760-surplus-args-drop.cjs` | 1/0 | `4` | ∅ | this call form is not supported yet [SC1090 at 1760-surplus-args-drop.cjs:27] |
| `1761-emitter-special-event-names.cjs` | 1/0 | `proto 1` | ∅ | 'the event '__proto__' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1761-emitter-special-event-names.cjs:14] |
| `1772-assert-dyn-js.cjs` | 1/0 | `cjs passes ok` | ∅ | 'assert.strictEqual of 'any' and 'number' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1772-assert-dyn-js.cjs:18] |
| `1781-http-server-shapes.cjs` | 1/0 | `call-form listening` | ∅ | listen callbacks with more than 0 parameters (use ()) are not supported yet [SC1090 at 1781-http-server-shapes.cjs:46] |
| `1795-dyn-handle-request.cjs` | 1/0 | `method GET url /one` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 1795-dyn-handle-request.cjs:23] |
| `1796-dyn-handle-body.cjs` | 1/0 | `identity held: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 1796-dyn-handle-body.cjs:19] |
| `1797-dyn-handle-socket.cjs` | 1/0 | `typeof socket: object, string form: [object Object]` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at 1797-dyn-handle-socket.cjs:16] |
| `1811-stream-option-value-callbacks.cjs` | 1/0 | `wrapped: 1` | ∅ | 'the Readable option 'read' with a function value of this signature' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1811-stream-option-value-callbacks.cjs:21] |
| `1814-stream-pipeline.cjs` | 1/0 | `sync` | ∅ | 'a 'pipeline' callback whose parameter 0 is 'any' where Node passes 'null \| Error'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1814-stream-pipeline.cjs:32] |
| `1815-stream-state-reads.cjs` | 1/0 | `flowing0: null` | ∅ | reading '_readableState' from a value of type 'Readable' is not supported yet [SC1090 at 1815-stream-state-reads.cjs:17] |
| `2032-cjs-export-assigned-class-expression/main.cjs` | 1/0 | `require sub: object` | ∅ | 'typeof m0.%cx472.' values crossing into dynamically-executed ('any'-typed) code is not supported yet [SC1090 at main.cjs:9] |
| `2036-evolving-array-decl.cjs` | 1/0 | `2` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `2037-fn-decl-hoisting.cjs` | 1/0 | `even0\|odd1\|even2` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `2160-dc-tracing-channel.cjs` | 1/0 | `caught sync boom` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2160-dc-tracing-channel.cjs:40] |
| `2161-js-object-literal-identity.cjs` | 1/0 | `identity ok` | ∅ | 'assert.strictEqual of 'unknown' and 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2161-js-object-literal-identity.cjs:19] |
| `2163-js-selfref-const.cjs` | 1/0 | `tick 2` | ∅ | the reference to 'exec' (a binding form with no lowering) is not supported yet [SC1090 at 2163-js-selfref-const.cjs:16] |
| `2164-js-then-dyn-handler.cjs` | 1/0 | `sync tail` | ∅ | then handlers with more than one parameter (the two-argument onRejected form has no lowering — chain .catch(...) instead) is not supported yet [SC1090 at 2164-js-then-dyn-handler.cjs:18] |
| `2165-js-throw-dyn.cjs` | 1/0 | `caught Error boom` | ∅ | passing a value of type 'Error' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2165-js-… |
| `2210-dyn-promise-crossing.cjs` | 1/0 | `object [object Promise] {"p":{}}` | ∅ | passing a value of type 'Promise<number>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `2211-dc-trace-promise.cjs` | 1/0 | `traced this.who = corpus` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2211-dc-trace-promise.cjs:26] |
| `2212-unhandled-rejection-listener.cjs` | 1/0 | `unhandled: nobody catches me` | ∅ | 'assert.strictEqual of 'any' and 'Error' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2212-unhandled-rejection-listener.cjs:13] |
| `2214-dc-bind-store.cjs` | 1/0 | `subscriber sees: {"data":{"foo":"bar"}}` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2214-dc-bind-store.cjs:37] |
| `2215-process-emit-warning-exit.cjs` | 1/1 | `Warning\|plain\|undefined\|undefined ; CustomWarning\|typed\|undefined\|undefined ; CW\|coded\|CODE1\|undefined ; OW\|op…` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2215-process-emit-warning-exit.cjs:33] |
| `2281-domexception-atob-btoa.cjs` | 1/0 | `abc true foo` | ∅ | 'new DOMException with a 'any' argument' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2281-domexception-atob-btoa.cjs:16] |
| `2283-structured-clone.cjs` | 1/0 | `true,false,true` | ∅ | passing a value of type 'DOMException' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2… |
| `2285-iferror-dyn.cjs` | 1/0 | `ok 42` | ∅ | 'assert.ifError over 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2285-iferror-dyn.cjs:6] |
| `2313-stream-underscore-assign-js.cjs` | 1/0 | `read size is number: true` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2313-stream-underscore-assign-js.cjs:18] |
| `2321-emitter-static-setmax.cjs` | 1/0 | `default-after 21` | ∅ | reading 'setMaxListeners' from a value of type 'typeof EventEmitter' is not supported yet [SC1090 at 2321-emitter-static-setmax.cjs:15] |
| `2322-dyn-array-sort.cjs` | 1/0 | `alpha,beta,gamma` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2322-dyn-array-sort.cjs:13] |
| `2383-cycle-assertdoc/main.js` | 1/0 | `checked ["x","y"]` | ∅ | loose equality (== and !=) is not supported yet [SC1040 at index.js:3] |
| `2464-qs-require-forms.cjs` | 1/0 | `Q1 {"a":["1","2"],"b":"x y z","c":""}` | ∅ | library functions as values (call 'require("querystring").escape' directly) are not supported yet [SC1090 at 2464-qs-require-forms.cjs:10] |
| `2470-mockable-module-shape.js` | 1/0 | `mocked tick` | ∅ | 'Object.hasOwn' is part of the standard library types but has no scriptc lowering yet (instantiating 'createMockable' with <{ tick: () => void }, "tick">) [SC2020 at 2470-mockable-module-shape.js:21] |
| `2473-option-table-widths.js` | 1/0 | `[{"value":"lf","description":"Line Feed only"},{"value":"crlf","description":"CR + LF"}]` | ∅ | JSON.stringify of '{ deprecated: string \| undefined; description: string; value: boolean \| string }[] \| undefined' values (Node's stringify of bare undefined is not a string at all — narrow with '!== undefined' first, model absence with a null arm, or use an o… |
| `2566-promise-reject-dyn-reason.js` | 1/0 | `sync end` | ∅ | passing a value of type 'Error' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2566-pro… |
| `2567-rest-spread-forward.js` | 1/0 | `47` | ∅ | spread arguments before positional arguments in island calls (one trailing spread after the fixed arguments is the supported form) are not supported yet [SC1090 at 2567-rest-spread-forward.js:24] |
| `2570-buffer-arg-validation.cjs` | 1/0 | `RangeError\|ERR_INVALID_BUFFER_SIZE\|Buffer size must be a multiple of 16-bits` | ∅ | passing a value of type '() => Uint8Array' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 … |
| `2572-readable-emitted-readable-flag.cjs` | 1/0 | `readable-fires true` | ∅ | reading '_readableState' from a value of type 'Readable' is not supported yet [SC1090 at 2572-readable-emitted-readable-flag.cjs:11] |
| `2573-fs-url-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_MISSING_ARGS\|The "url" argument must be specified` | ∅ | reading 'revokeObjectURL' from a value of type '{ new (input: string, base?: string \| URL \| undefined): URL; parse(input: string, base?: string \| URL \| undefined): URL \| null; canParse(input: string, base?: string \| ... 1 more ... \| undefined): boolean; }' is … |
| `2574-emitter-max-listeners-ladders.cjs` | 1/0 | `RangeError\|ERR_OUT_OF_RANGE\|The value of "setMaxListeners" is out of range. It must be >= 0. Received NaN` | ∅ | 'events.EventEmitter' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2574-emitter-max-listeners-ladders.cjs:30] |
| `2577-builtin-global-destructuring.js` | 1/0 | `true` | ∅ | bindings with 'any' storage over the builtin global 'globalThis' is not supported yet [SC1031 at 2577-builtin-global-destructuring.js:9] |
| `2582-jsval-object-statics.js` | 1/0 | `b,a,list,extra` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2582-jsval-object-statics.js:19] |
| `2584-jsval-object-statics.js` | 1/0 | `b,a,list,extra` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2584-jsval-object-statics.js:19] |
| `2586-object-assign-spread.js` | 1/0 | `semi,tabWidth,core` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2586-object-assign-spread.js:24] |
| `2589-object-create-null.cjs` | 1/0 | `object {} ` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2589-object-create-null.cjs:16] |
| `2595-fs-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "cb" argument must be of type function. Received undefined` | ∅ | 'fs.exists' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2595-fs-arg-ladders.cjs:27] |
| `2598-tls-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "options.ciphers" property must be of type string. Received type number (1)` | ∅ | 'tls.createSecureContext with a non-literal options argument' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2598-tls-arg-ladders.cjs:14] |
| `2599-stream-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "stream" argument must be an instance of ReadableStream, WritableStream, or…` | ∅ | 'finished over a 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2599-stream-arg-ladders.cjs:14] |
| `2600-dyn-keyed-write-harness.js` | 1/0 | `handled DeprecationWarning going away DEP0005` | ∅ | this call form is not supported yet [SC1090 at 2600-dyn-keyed-write-harness.js:36] |
| `2601-dyn-keyed-write-ops.js` | 1/0 | `7,a,b,c` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2601-dyn-keyed-write-ops.js:16] |
| `2624-ee-override-js.cjs` | 1/0 | `fwd:a` | ∅ | 'the event 'a' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2624-ee-override-js.cjs:21] |
| `2628-stream-push-encodings.cjs` | 1/0 | `ctor-throw TypeError ERR_UNKNOWN_ENCODING Unknown encoding: not-a-thing` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2628-stream-push-encodings.cjs:15] |
| `2634-stream-pipeline-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "body" argument must be of type function or an instance of Blob, ReadableSt…` | ∅ | 'pipeline over a 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2634-stream-pipeline-arg-ladders.cjs:19] |
| `2638-http-dyn-res-compat.cjs` | 1/0 | `srv /plain req.destroyed: false req.readable: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 2638-http-dyn-res-compat.cjs:20] |
| `2639-http-dyn-req-pause.cjs` | 1/0 | `pausing after first chunk: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 2639-http-dyn-req-pause.cjs:19] |
| `2640-net-dyn-socket-compat.cjs` | 1/0 | `setNoDelay is sock: true` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at 2640-net-dyn-socket-compat.cjs:19] |
| `2641-http-agent-surface.cjs` | 1/0 | `body: ok:/merged` | ∅ | data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet [SC1090 at 2641-http-agent-surface.cjs:37] |
| `2691-received-tail-specific-types.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "stream" argument must be an instance of ReadableStream, WritableStream, or…` | ∅ | 'finished over a 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2691-received-tail-specific-types.cjs:32] |
| `2744-http-option-carry-dyn.cjs` | 1/0 | `agent timeout -3: RangeError ERR_OUT_OF_RANGE The value of "msecs" is out of range. It must be a non-negative …` | ∅ | 'a request 'agent' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2744-http-option-carry-dyn.cjs:45] |
| `2822-variadic-builtin-callbacks.js` | 1/0 | `12` | ∅ | a variadic callback (a rest parameter or 'arguments') using an object or array argument (it would be a copy here, where Node passes the object itself — declare the parameter instead) is not supported yet [SC1090 at 2822-variadic-builtin-callbacks.js:19] |
| `2824-builtin-global-values.js` | 1/0 | `object function` | ∅ | the builtin 'process' used as a value (it has no runtime object here — comparisons with another builtin, truthiness and builtin-only Set membership tests lower; read and call its members directly) is not supported yet [SC1090 at 2824-builtin-global-values.js:1… |
| `2845-in-dynamic-runtime-key.mjs` | 1/0 | `true false true true` | ∅ | 'in' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers) is not supported yet [SC1090 at 2845-in-dynamic-runtime-key.mjs:5] |
| `2948-fn-decl-binding-review.cjs` | 1/0 | `two:1:2 two:1:undefined 2` | ∅ | this call form is not supported yet [SC1090 at 2948-fn-decl-binding-review.cjs:18] |
| `N1-C-1797` | 1/— | `typeof socket: object, string form: [object Object]` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at 1797-dyn-handle-socket.cjs:16] |
| `N1-C-2599` | 1/— | `TypeError\|ERR_INVALID_ARG_TYPE\|The "stream" argument must be an instance of ReadableStream, WritableStream, or…` | ∅ | 'finished over a 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2599-stream-arg-ladders.cjs:14] |
| `N1-C-2640` | 1/— | `setNoDelay is sock: true` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at 2640-net-dyn-socket-compat.cjs:19] |
| `N1-DMW-01` | 1/— | `write returned false` | ∅ | connect listeners with more than 0 parameters (use ()) are not supported yet [SC1090 at main.cjs:18] |
| `N1-SOON-01` | 1/— | `write cb null 6` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at main.cjs:12] |
| `N1-DYN-01` | 1/— | `object [object Object] true` | ∅ | connection handlers with more than 1 parameter (use (socket) or ()) is not supported yet [SC1090 at main.cjs:12] |
| `N1-ADOPT-01` | 1/— | `sync` | ∅ | passing a value of type 'Server' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at main.cj… |
| `N1-PEND-03` | 1/— | `connect` | ∅ | values of type '() => any' cannot be compiled: the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity [SC2009 at main.cjs:14] |
| `N1-REG-02` | 1/— | `  "stderr": "tsinter: unsupported: 'in' or Object.hasOwn on a net handle is not supported yet [SC1090]` | `  "stderr": "tsinter: unsupported: values of type '() => any' cannot be compiled: the function shape is suppor…` | values of type '() => any' cannot be compiled: the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity [SC2009 at main.cjs:10] |
| `N2-C-1781` | 1/— | `call-form listening` | ∅ | listen callbacks with more than 0 parameters (use ()) are not supported yet [SC1090 at 1781-http-server-shapes.cjs:46] |
| `N2-C-1795` | 1/— | `method GET url /one` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 1795-dyn-handle-request.cjs:23] |
| `N2-C-1796` | 1/— | `identity held: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 1796-dyn-handle-body.cjs:19] |
| `N2-C-2638` | 1/— | `srv /plain req.destroyed: false req.readable: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 2638-http-dyn-res-compat.cjs:20] |
| `N2-C-2639` | 1/— | `pausing after first chunk: true` | ∅ | request handlers with more than two parameters (use (req, res)) are not supported yet [SC1090 at 2639-http-dyn-req-pause.cjs:19] |
| `N2-C-2641` | 1/— | `freeSockets empty: {}` | `freeSockets empty: {}` | data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet [SC1090 at 2641-http-agent-surface.cjs:37] |
| `N2-C-2744` | 1/— | `a long scheduling: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. R…` | `a long scheduling: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'lifo'. R…` | 'a request 'agent' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2744-http-option-carry-dyn.cjs:45] |
| `N2-OPT-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | 'a get 'agent' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:32] |
| `N2-FRAME-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-AGENT-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | 'a get 'path' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:15] |
| `N2-ENDCB-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-ENDCB-02` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-RAW-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-ODD-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-HDR-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-REG-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `U4-C-2598` | 1/— | `TypeError\|ERR_INVALID_ARG_TYPE\|The "options.ciphers" property must be of type string. Received type number (1)` | ∅ | 'tls.createSecureContext with a non-literal options argument' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2598-tls-arg-ladders.cjs:14] |
| `U4-TLS-02` | 1/— | `garbage Error ERR_SSL_WRONG_VERSION_NUMBER true` | ∅ | 'tls.connect with a 'any' options record' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:18] |
| `QS-C-2464` | 1/— | `Q1 {"a":["1","2"],"b":"x y z","c":""}` | ∅ | library functions as values (call 'require("querystring").escape' directly) are not supported yet [SC1090 at 2464-qs-require-forms.cjs:10] |
| `H-C-2570` | 1/— | `RangeError\|ERR_OUT_OF_RANGE\|The value of "offset" is out of range. It must be >= 0 && <= 9. Received 10` | `RangeError\|ERR_OUT_OF_RANGE\|The value of "offset" is out of range. It must be >= 0 && <= 9. Received 10` | passing a value of type '() => Uint8Array' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 … |
| `H-BUF-03` | 1/— | `  "stderr": "tsinter: unsupported: new Buffer(value, encoding) over a string, an array or an array-like value …` | `  "stderr": "tsinter: unsupported: 'new Buffer' is part of the standard library types but has no scriptc lower…` | 'new Buffer' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:10] |
| `B218-03` | 1/— | `TypeError w is not iterable` | `TypeError w is not iterable` | 'assert.deepStrictEqual of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:16] |
| `B218-05` | 1/— | `The "address" argument must be of type string. Received an instance of WeakMap` | `The "address" argument must be of type string. Received an instance of WeakMap` | ''on' with a non-function listener' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:11] |
| `DCALS-C-2160` | 1/— | `start step=one \| end step=one result=42` | `start step=one \| end step=one result=42` | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2160-dc-tracing-channel.cjs:40] |
| `DCALS-C-2211` | 1/— | `traced this.who = corpus` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2211-dc-trace-promise.cjs:26] |
| `DCALS-C-2214` | 1/— | `bound counts as active: true` | `bound counts as active: true` | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2214-dc-bind-store.cjs:37] |
| `DCALS-03` | 1/— | `undefined same` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at main.cjs:37] |
| `DCALS-04` | 1/— | `run-num TypeError undefined Function.prototype.apply was called on 5, which is a number and not a function` | ∅ | channel subscribers of type 'any' (subscribers cross as dyn functions — parameters must be dyn-representable) is not supported yet [SC1090 at main.cjs:15] |
| `DCALS-05` | 1/— | `start:S:one:true` | ∅ | the '===' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at main.cjs:11] |
| `DCALS-07` | 1/— | `{"k":1,"error":{}}` | ∅ | passing a value of type 'Error' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at main.cjs… |
| `DCALS-F1` | 1/— | `  "stderr": "tsinter: unsupported: tracePromise without subscribers over a function returning a non-promise is…` | `  "stderr": "tsinter: unsupported: 'Promise<unknown>' values where 'Promise<any>' is expected is not supported…` | 'Promise<unknown>' values where 'Promise<any>' is expected is not supported yet [SC1090 at main.cjs:15] |

### (i) Newly refused or failing to compile: 101, grouped by first diagnostic

Corpus programs were rebuilt with `tsinter build --backend wasm [--dynamic]` on the same checkout and stage to capture the diagnostic text (the harness only reports codes). Quoted names inside the messages are shown as '…' for grouping. Programs listed under a group can also have further diagnostics (the counts after each name).

- **18**: SC2020: '…' is part of the standard library types but has no scriptc lowering yet
  - `1473-promisify-execfile.ts [util.promisify]`, `1548-boolean-condition-forms.ts [Object.keys]`, `1573-promisify-execfile-env-spread.ts [util.promisify]`, `1600-assert-passing.ts [assert.deepStrictEqual of 'any' values] (+1: SC2020)`, `1604-assert-deep-structures.ts [assert.deepStrictEqual of 'any' values] (+4: SC2020)`, `1605-assert-import-forms.ts [assert.deepStrictEqual of 'any' values]`, `1606-assert-strict-module.ts [assert.deepStrictEqual of 'any' values] (+3: SC2020)`, `1609-assert-async.ts [assert.deepStrictEqual of 'any' values]`, `1681-assert-funcs.ts [assert.deepStrictEqual of 'any' values] (+3: SC2020)`, `1771-assert-dyn-deep.ts [assert.deepStrictEqual of 'any' values] (+4: SC2020)`, `1773-assert-dyn-exit.ts [assert.deepStrictEqual of 'any' values]`, `1812-stream-super-options-forwarding.cjs [new Readable with a non-literal options argument] (+1: SC2020)`, `1983-array-tuple-surfaces.ts [String.raw substitutions of type 'any']`, `2361-assign-index-record.ts [Object.assign] (+4: SC2020)`, `2446-performance-global.ts [performance]`, `2561-object-is.ts [Object.is over a dynamic operand]`, `2743-http-option-carry.ts [writeHead with a 'any' headers argument]`, `914-records-from-entries.ts [Object.entries] (+4: SC2020,SC1090)`
- **14**: harness build refused: SC2020: '…' is part of the standard library types but has no scriptc lowering yet
  - `U1-C-1473 (harness) [util.promisify]`, `U1-C-1573 (harness) [util.promisify]`, `U1-ERR-04 (harness) [util.promisify]`, `U1-VAL-09 (harness) [util.promisify]`, `U1-HYG-01 (harness) [util.promisify]`, `U1-REG-02 (harness) [util.promisify]`, `U1-REG-05 (harness) [util.promisify]`, `U1-REG-11 (harness) [util.promisify]`, `N2-C-2743 (harness) [writeHead with a 'any' headers argument]`, `U4-TLS-01 (harness) [tls.connect with a 'any' options record]`, `U4-REG-01 (harness) [tls.connect with a 'any' options record]`, `U4-R-01 (harness) [tls.connect with a 'any' options record]`, `U4-R-10 (harness) [tls.connect with a 'any' options record]`, `U4-R-14 (harness) [tls.connect with a 'any' options record]`
- **11**: SC1090: an '…' value flowing into a typed '…' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (S115)
  - `1007-json-rc-stress.ts`, `1551-dyn-receiver-methods.ts (+5: SC2011,SC1090,SC2004)`, `1558-any-joins-and-dyn-validation.ts`, `1575-unknown-assert-into-record.ts`, `2040-any-bindings.ts`, `2081-destructuring-rest.ts`, `2094-diagnostics-channel.ts (+1: SC1090)`, `2615-nullish-field-record-binding.ts`, `2629-stream-consumers.ts`, `2631-create-require/main.ts (+1: SC1090)`, `2637-create-require-bare/main.ts`
- **8**: SC1090: a checked cast of '…' to '…' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet
  - `1005-json-nested.ts (+1: SC1090)`, `1011-json-unknown-typeof.ts (+1: SC1040)`, `2739-unknown-array.ts`, `541-ref-array-json.ts (+4: SC1090)`, `909-records-index-json.ts (+2: SC1090)`, `910-records-index-rc-stress.ts (+1: SC1090)`, `913-records-index-iteration.ts (+3: SC2020)`, `915-unknown-tostring-eq.ts (+3: SC2020,SC1040,SC1090)`
- **5**: SC1090: '…' on values other than class instances (narrow union-typed values first) are not supported yet
  - `1554-caught-into-unknown.ts (+2: SC1090)`, `2654-top-level-await-unrelated-rejection.ts`, `2663-top-level-await-dependency-errors/main.ts`, `2664-top-level-await-same-checkpoint-rejection.ts`, `2765-module-tdz/main.ts`
- **5**: SC1090: a checked cast of '…' to '…' (an '…' value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet
  - `1574-dyn-optional-method-number-keys.ts`, `1666-dyn-fn-identity.ts (+3: SC1090)`, `908-records-index-signatures.ts (+5: SC1090)`, `911-records-index-dot-access.ts (+2: SC1090)`, `916-unknown-bytes.ts (+4: SC1090)`
- **4**: harness build refused: SC1090: data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet
  - `URL-C-2644 (harness)`, `URL-HTTP-01 (harness)`, `U4-C-2645 (harness)`, `U4-VERIFY-01 (harness)`
- **4**: SC1090: passing a value of type '…' into dynamically-executed ('…'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet
  - `1633-inspect-map-set.ts (+2: SC1090)`, `1634-inspect-classes.ts (+2: SC1090)`, `1798-dyn-handle-typed-box.ts (+1: SC1090)`, `2047-objlit-accessors-shapes.ts`
- **3**: SC1090: generic functions as values without a pinned concrete signature (annotate the destination — e.g. '…' — instantiate explicitly ('…'), or call '…' directly) is not supported yet
  - `2551-generics-value-aliases.ts (+5: SC1090,SC2004)`, `2553-generics-signature-bindings.ts`, `2554-generics-frontier-mix.ts`
- **3**: SC2011: values of type '…' have no static representation but run in the embedded dynamic engine, which this build does not include
  - `1637-inspect-dyn.ts`, `2738-union-dyn-collapse.ts`, `519-array-from-length.ts (+4: SC2011)`
- **2**: harness build refused: SC1090: an '…' value flowing into a typed '…' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (S115)
  - `DCALS-C-2094 (harness)`, `F-CAUSE-01 (harness)`
- **2**: SC1031: rest elements in destructuring assignment from checked-dynamic sources (collect with .slice() instead) are not supported yet
  - `2082-destructuring-assignment.ts`, `2537-destructuring-assign-member-targets.ts`
- **2**: SC1090: data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet
  - `2644-http-client-url-argument.ts (+2: SC1090)`, `2645-https-client-url-argument.ts (+1: SC1090)`
- **2**: SC1090: the reference to '…' (a binding form with no lowering) is not supported yet
  - `1982-freeze-resolve-passthrough.ts`, `2823-arguments-length-static.ts (+5: SC1090)`
- **2**: SC3001 (expr:jsOp)
  - `2632-dyn-jsval-iterate.js`, `2758-math-static-raw.ts`
- **1**: harness build refused: SC1090: passing a value of type '…' into dynamically-executed ('…'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet
  - `N2-C-1798 (harness)`
- **1**: harness build refused: SC3001: the wasm backend does not support this construct yet (expr:jsOp); build with the LLVM backend (the default) or the reference C backend (--backend c)
  - `N2-REG-05 (harness)`
- **1**: SC1040: loose equality (== and !=) is not supported yet
  - `912-unknown-slots.ts (+3: SC1090)`
- **1**: SC1090: '…' on '…' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; narrow first: check a discriminant field, or compare with '…' for unit arms) are not supported yet
  - `1544-dyn-json-reads.ts (+1: SC1090)`
- **1**: SC1090: '…' right-hand sides other than classes declared in the program is not supported yet
  - `1451-instanceof-uint8array-unknown.ts (+5: SC1090)`
- **1**: SC1090: '…' values where '…' is expected is not supported yet
  - `2630-stream-consumers-errors.ts (+3: SC2004,SC1090)`
- **1**: SC1090: '…' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers) is not supported yet
  - `2364-in-runtime-key.ts (+5: SC1090,SC2002)`
- **1**: SC1090: generic arrow/function expressions outside a never-reassigned module-scope binding (only `const f = <T>(x: T) => ...` bindings and top-level generic function declarations monomorphize) is not supported yet
  - `2003-generic-methods-object-literal.ts`
- **1**: SC1090: string methods as values (call '…' directly) are not supported yet
  - `2796-regex-replace-callbacks.ts`
- **1**: SC1090: using an '…' value where '…' is expected (an '…' value can only exit to numbers, strings, booleans, JSON-safe records/arrays/unions, and '…' over those) is not supported yet
  - `2243-width-assert-satisfies-shapes.ts`
- **1**: SC1100: operators on '…' values are not supported yet
  - `2578-jsval-into-unknown-rows.ts`
- **1**: SC2020: '…'(() => void)[]'…' is part of the standard library types but has no scriptc lowering yet
  - `1677-emitter-listeners.ts [assert.deepStrictEqual of '(() => void)[]' and 'any' values]`
- **1**: SC2020: '…'((number, number) => void)[]'…' is part of the standard library types but has no scriptc lowering yet
  - `2687-arity-widen-identity.ts [assert.notDeepStrictEqual of '((number, number) => void)[]' and 'any' values] (+5: SC1090)`
- **1**: SC2020: '…'any'…' is part of the standard library types but has no scriptc lowering yet
  - `1747-stream-for-await-js.cjs [a '_transform' method whose parameter 0 is 'any' where Node passes 'Uint8Array']`
- **1**: SC2020: '…'number'…' is part of the standard library types but has no scriptc lowering yet
  - `1770-assert-dyn-strict.ts [assert.strictEqual of 'any' and 'number' values] (+4: SC2020)`
- **1**: SC9001: internal compiler error: in main: libCall readable.fromArr must take an array and return a stream class — please report this
  - `1746-stream-for-await.ts (+1: SC9001)`

### (iii) Newly passing: 0

None.

---

## Run: 4eb9a7e3, `SCRIPTC_U1_STAGE=world`

- `wasm tier: 1092/1135 corpus programs claimed; first refusals: module:embedded×3, expr:jsOp:regexp-source-escape×2, expr:jsOp×1`
- `wasm work queue (4 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3, expr:jsOp:regexp-source-escape×2, expr:jsOp×1`

### (ii) Output differences / traps: 101 (6 silent, 95 loud runtime fences)

**Silent (6):** `1664-dyn-fn-boundary.cjs`, `1667-dyn-fn-not-callable.cjs`, `2639-http-dyn-req-pause.cjs`, `2640-net-dyn-socket-compat.cjs`, `N1-C-2640`, `N2-C-2639`. Details are in the section above.

**Loud runtime fences (95).** Expected = Node's first stdout line that is missing or different. Actual = the wasm line (`∅` means stdout ends there). Exit is wasm/Node (harness rows: wasm only). The construct is the fence's own message.

| test | exit | expected (Node) | actual (wasm) | construct (fence message) |
|---|---|---|---|---|
| `1612-cjs-module-globals.cjs` | 1/0 | `G1 string string` | ∅ | the builtin 'process' used as a value (it has no runtime object here — comparisons with another builtin, truthiness and builtin-only Set membership tests lower; read and call its members directly) is not supported yet [SC1090 at 1612-cjs-module-globals.cjs:8] |
| `1614-js-fence-dodges.cjs` | 1/0 | `F1 true` | ∅ | syntax 'BigIntLiteral' is not supported yet [SC1090 at 1614-js-fence-dodges.cjs:13] |
| `1615-cjs-export-shapes/main.cjs` | 1/0 | `T1 first` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at proxied.cjs:17] |
| `1643-metadata-dyn-return.cjs` | 1/0 | `[ '--expose-internals', '--no-warnings' ]` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `1665-dyn-fn-mustcall/main.cjs` | 1/0 | `done code=0 signal=none` | ∅ | passing 'unknown' values where '(any, any, any) => any' is expected is not supported yet [SC1100 at main.cjs:16] |
| `1668-dyn-fn-throws.cjs` | 1/1 | `call 1` | ∅ | passing 'unknown' values where '(any) => any' is expected is not supported yet [SC1100 at 1668-dyn-fn-throws.cjs:23] |
| `1678-emitter-dyn-listeners.cjs` | 1/0 | `arrow got 5 number` | ∅ | 'the event 'x' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1678-emitter-dyn-listeners.cjs:11] |
| `1679-console-dyn.js` | 1/0 | `[` | ∅ | values of type '(_: any, i: number) => number' have no static representation but run in the embedded dynamic engine, which this build does not include [SC2011 at 1679-console-dyn.js:23] |
| `1700-mustcall-common/main.cjs` | 1/0 | `onTwice 1 2` | ∅ | this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported) is not supported yet [SC1090 at common.cjs:57] |
| `1701-mustcall-exit-report/main.cjs` | 1/1 | `end of main` | ∅ | this property form in an 'any'-typed object literal (only `name: value`, shorthand names, methods, and get accessors are supported) is not supported yet [SC1090 at common.cjs:57] |
| `1703-arguments-rest-props.cjs` | 1/0 | `n=0 first=undefined` | ∅ | values of type '() => string' cannot be compiled: the function shape is supported, but its signature is variadic ('arguments'-reading), and a compiled signature is fixed-arity [SC2009 at 1703-arguments-rest-props.cjs:14] |
| `1710-cjs-export-class/main.js` | 1/0 | `dec → 2` | ∅ | increment/decrement of record fields or elements in expression position is not supported yet [SC1045 at countdown.js:20] |
| `1713-js-dyn-fields.js` | 1/0 | `take(2) → 3` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at 1713-js-dyn-fields.js:16] |
| `1730-countdown-symbol-keys/main.js` | 1/0 | `start: 3` | ∅ | passing 'unknown' values where '(any, any, any) => any' is expected is not supported yet [SC1100 at countdown.js:13] |
| `1731-symbol-field-shapes.cjs` | 1/0 | `bump -> 7` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at 1731-symbol-field-shapes.cjs:27] |
| `1732-symbol-field-cross-module/main.js` | 1/0 | `tick -> 8` | ∅ | comparing non-number, non-string values are not supported yet [SC1043 at timer.js:14] |
| `1745-stream-encoding-js.cjs` | 1/0 | `plain len: 3 first byte: 120` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1745-stream-encoding-js.cjs:10] |
| `1760-surplus-args-drop.cjs` | 1/0 | `4` | ∅ | this call form is not supported yet [SC1090 at 1760-surplus-args-drop.cjs:27] |
| `1761-emitter-special-event-names.cjs` | 1/0 | `proto 1` | ∅ | 'the event '__proto__' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1761-emitter-special-event-names.cjs:14] |
| `1781-http-server-shapes.cjs` | 1/0 | `/call -> call-form` | ∅ | 'a get 'port' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1781-http-server-shapes.cjs:32] |
| `1796-dyn-handle-body.cjs` | 1/0 | `identity held: true` | ∅ | 'a request 'port' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1796-dyn-handle-body.cjs:41] |
| `1811-stream-option-value-callbacks.cjs` | 1/0 | `wrapped: 1` | ∅ | 'the Readable option 'read' with a function value of this signature' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1811-stream-option-value-callbacks.cjs:21] |
| `1814-stream-pipeline.cjs` | 1/0 | `sync` | ∅ | 'a 'pipeline' callback whose parameter 0 is 'any' where Node passes 'null \| Error'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1814-stream-pipeline.cjs:32] |
| `1815-stream-state-reads.cjs` | 1/0 | `flowing0: null` | ∅ | reading '_readableState' from a value of type 'Readable' is not supported yet [SC1090 at 1815-stream-state-reads.cjs:17] |
| `2032-cjs-export-assigned-class-expression/main.cjs` | 1/0 | `require sub: object` | ∅ | 'typeof m0.%cx472.' values crossing into dynamically-executed ('any'-typed) code is not supported yet [SC1090 at main.cjs:9] |
| `2036-evolving-array-decl.cjs` | 1/0 | `2` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `2037-fn-decl-hoisting.cjs` | 1/0 | `even0\|odd1\|even2` | ∅ | an 'unknown' value flowing into a typed 'string[]' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so both sides share one… |
| `2161-js-object-literal-identity.cjs` | 1/0 | `identity ok` | ∅ | 'assert.strictEqual of 'unknown' and 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2161-js-object-literal-identity.cjs:19] |
| `2165-js-throw-dyn.cjs` | 1/0 | `caught Error boom` | ∅ | passing a value of type 'Error' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2165-js-… |
| `2210-dyn-promise-crossing.cjs` | 1/0 | `object [object Promise] {"p":{}}` | ∅ | passing a value of type 'Promise<number>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `2211-dc-trace-promise.cjs` | 1/0 | `rejected identity ok: tp boom` | ∅ | 'assert.strictEqual of 'any' and 'Error' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2211-dc-trace-promise.cjs:43] |
| `2214-dc-bind-store.cjs` | 1/0 | `subscriber sees: {"data":{"foo":"bar"}}` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2214-dc-bind-store.cjs:37] |
| `2215-process-emit-warning-exit.cjs` | 1/1 | `Warning\|plain\|undefined\|undefined ; CustomWarning\|typed\|undefined\|undefined ; CW\|coded\|CODE1\|undefined ; OW\|op…` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2215-process-emit-warning-exit.cjs:33] |
| `2283-structured-clone.cjs` | 1/0 | `true,false,true` | ∅ | passing a value of type 'DOMException' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2… |
| `2285-iferror-dyn.cjs` | 1/0 | `ok 42` | ∅ | 'assert.ifError over 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2285-iferror-dyn.cjs:6] |
| `2313-stream-underscore-assign-js.cjs` | 1/0 | `read size is number: true` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2313-stream-underscore-assign-js.cjs:18] |
| `2321-emitter-static-setmax.cjs` | 1/0 | `default-after 21` | ∅ | reading 'setMaxListeners' from a value of type 'typeof EventEmitter' is not supported yet [SC1090 at 2321-emitter-static-setmax.cjs:15] |
| `2322-dyn-array-sort.cjs` | 1/0 | `1,10,2,3 identity true` | ∅ | operators on 'unknown' values are not supported yet [SC1100 at 2322-dyn-array-sort.cjs:18] |
| `2383-cycle-assertdoc/main.js` | 1/0 | `checked ["x","y"]` | ∅ | loose equality (== and !=) is not supported yet [SC1040 at index.js:3] |
| `2464-qs-require-forms.cjs` | 1/0 | `Q1 {"a":["1","2"],"b":"x y z","c":""}` | ∅ | library functions as values (call 'require("querystring").escape' directly) are not supported yet [SC1090 at 2464-qs-require-forms.cjs:10] |
| `2470-mockable-module-shape.js` | 1/0 | `mocked tick` | ∅ | 'Object.hasOwn' is part of the standard library types but has no scriptc lowering yet (instantiating 'createMockable' with <{ tick: () => void }, "tick">) [SC2020 at 2470-mockable-module-shape.js:21] |
| `2473-option-table-widths.js` | 1/0 | `[{"value":"lf","description":"Line Feed only"},{"value":"crlf","description":"CR + LF"}]` | ∅ | JSON.stringify of '{ deprecated: string \| undefined; description: string; value: boolean \| string }[] \| undefined' values (Node's stringify of bare undefined is not a string at all — narrow with '!== undefined' first, model absence with a null arm, or use an o… |
| `2566-promise-reject-dyn-reason.js` | 1/0 | `sync end` | ∅ | passing a value of type 'Error' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at 2566-pro… |
| `2567-rest-spread-forward.js` | 1/0 | `47` | ∅ | spread arguments before positional arguments in island calls (one trailing spread after the fixed arguments is the supported form) are not supported yet [SC1090 at 2567-rest-spread-forward.js:24] |
| `2570-buffer-arg-validation.cjs` | 1/0 | `RangeError\|ERR_INVALID_BUFFER_SIZE\|Buffer size must be a multiple of 16-bits` | ∅ | passing a value of type '() => Uint8Array' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 … |
| `2572-readable-emitted-readable-flag.cjs` | 1/0 | `readable-fires true` | ∅ | reading '_readableState' from a value of type 'Readable' is not supported yet [SC1090 at 2572-readable-emitted-readable-flag.cjs:11] |
| `2573-fs-url-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_MISSING_ARGS\|The "url" argument must be specified` | ∅ | reading 'revokeObjectURL' from a value of type '{ new (input: string, base?: string \| URL \| undefined): URL; parse(input: string, base?: string \| URL \| undefined): URL \| null; canParse(input: string, base?: string \| ... 1 more ... \| undefined): boolean; }' is … |
| `2574-emitter-max-listeners-ladders.cjs` | 1/0 | `RangeError\|ERR_OUT_OF_RANGE\|The value of "setMaxListeners" is out of range. It must be >= 0. Received NaN` | ∅ | 'events.EventEmitter' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2574-emitter-max-listeners-ladders.cjs:30] |
| `2577-builtin-global-destructuring.js` | 1/0 | `true` | ∅ | bindings with 'any' storage over the builtin global 'crypto' is not supported yet [SC1031 at 2577-builtin-global-destructuring.js:13] |
| `2586-object-assign-spread.js` | 1/0 | `semi,tabWidth,core` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2586-object-assign-spread.js:24] |
| `2589-object-create-null.cjs` | 1/0 | `object {} ` | ∅ | 'Object.keys' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2589-object-create-null.cjs:16] |
| `2595-fs-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_TYPE\|The "cb" argument must be of type function. Received undefined` | ∅ | 'fs.exists' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2595-fs-arg-ladders.cjs:27] |
| `2599-stream-arg-ladders.cjs` | 1/0 | `TypeError\|ERR_INVALID_ARG_VALUE\|The property 'options.type' must be one of: 'bytes', undefined. Received 'wron…` | ∅ | reading 'toWeb' from a value of type 'typeof Readable' is not supported yet [SC1090 at 2599-stream-arg-ladders.cjs:18] |
| `2600-dyn-keyed-write-harness.js` | 1/0 | `handled DeprecationWarning going away DEP0005` | ∅ | this call form is not supported yet [SC1090 at 2600-dyn-keyed-write-harness.js:36] |
| `2624-ee-override-js.cjs` | 1/0 | `fwd:a` | ∅ | 'the event 'a' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2624-ee-override-js.cjs:21] |
| `2628-stream-push-encodings.cjs` | 1/0 | `ctor-throw TypeError ERR_UNKNOWN_ENCODING Unknown encoding: not-a-thing` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2628-stream-push-encodings.cjs:15] |
| `2634-stream-pipeline-arg-ladders.cjs` | 1/0 | `piped:flow` | ∅ | 'a 'data' listener whose chunk parameter is 'any'' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2634-stream-pipeline-arg-ladders.cjs:35] |
| `2638-http-dyn-res-compat.cjs` | 1/0 | `srv /plain req.destroyed: false req.readable: true` | ∅ | 'a get 'path' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2638-http-dyn-res-compat.cjs:64] |
| `2641-http-agent-surface.cjs` | 1/0 | `sockets has name: true len: 1` | ∅ | an 'unknown' value flowing into a typed '{ [key: string]: unknown }' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so bo… |
| `2642-http-agent-maxsockets.cjs` | 1/0 | `res2 200 still queued: false active: 1` | ∅ | an 'unknown' value flowing into a typed '{ [key: string]: unknown }' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so bo… |
| `2744-http-option-carry-dyn.cjs` | 1/0 | `scheduling with a quote: TypeError ERR_INVALID_ARG_VALUE The argument 'scheduling' must be one of: 'fifo', 'li…` | ∅ | the '+' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at 2744-http-option-carry-dyn.cjs:18] |
| `2822-variadic-builtin-callbacks.js` | 1/0 | `12` | ∅ | a variadic callback (a rest parameter or 'arguments') using an object or array argument (it would be a copy here, where Node passes the object itself — declare the parameter instead) is not supported yet [SC1090 at 2822-variadic-builtin-callbacks.js:19] |
| `2824-builtin-global-values.js` | 1/0 | `object function` | ∅ | the builtin 'process' used as a value (it has no runtime object here — comparisons with another builtin, truthiness and builtin-only Set membership tests lower; read and call its members directly) is not supported yet [SC1090 at 2824-builtin-global-values.js:1… |
| `2845-in-dynamic-runtime-key.mjs` | 1/0 | `true false true true` | ∅ | 'in' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers) is not supported yet [SC1090 at 2845-in-dynamic-runtime-key.mjs:5] |
| `2948-fn-decl-binding-review.cjs` | 1/0 | `two:1:2 two:1:undefined 2` | ∅ | this call form is not supported yet [SC1090 at 2948-fn-decl-binding-review.cjs:18] |
| `N1-C-2599` | 1/— | `TypeError\|ERR_INVALID_ARG_TYPE\|The "stream" argument must be an instance of ReadableStream, WritableStream, or…` | `TypeError\|ERR_INVALID_ARG_TYPE\|The "stream" argument must be an instance of ReadableStream, WritableStream, or…` | reading 'toWeb' from a value of type 'typeof Readable' is not supported yet [SC1090 at 2599-stream-arg-ladders.cjs:18] |
| `N1-DYN-01` | 1/— | `object [object Object] true` | ∅ | the '===' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at main.cjs:14] |
| `N1-ADOPT-01` | 1/— | `np http object true` | `np http object true` | the '===' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at main.cjs:28] |
| `N1-REG-02` | 1/— | `  "stderr": "tsinter: unsupported: 'in' or Object.hasOwn on a net handle is not supported yet [SC1090]` | `  "stderr": "tsinter: unsupported: 'in' on 'any' receivers (only process.env, Error instances, record-typed va…` | 'in' on 'any' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; narrow first: check a discriminant field, or compare with '!== undefined'/'!== null' for unit arms) are not supported yet [SC1090 at main… |
| `N2-C-1781` | 1/— | `call-form listening` | `call-form listening` | 'a get 'port' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1781-http-server-shapes.cjs:32] |
| `N2-C-1796` | 1/— | `identity held: true` | ∅ | 'a request 'port' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 1796-dyn-handle-body.cjs:41] |
| `N2-C-2638` | 1/— | `srv /plain req.destroyed: false req.readable: true` | ∅ | 'a get 'path' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2638-http-dyn-res-compat.cjs:64] |
| `N2-C-2641` | 1/— | `status: 200` | `status: 200` | an 'unknown' value flowing into a typed '{ [key: string]: unknown }' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so bo… |
| `N2-C-2642` | 1/— | `res1 200 active: 1 queued: 1` | `res1 200 active: 1 queued: 1` | an 'unknown' value flowing into a typed '{ [key: string]: unknown }' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (SEMANTICS.md S115) — keep the slot 'any'/'any[]' so bo… |
| `N2-C-2744` | 1/— | `scheduling: fifo lifo lifo` | `scheduling: fifo lifo lifo` | the '+' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at 2744-http-option-carry-dyn.cjs:18] |
| `N2-OPT-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | 'a get 'agent' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:32] |
| `N2-FRAME-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-AGENT-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | 'a get 'path' option of 'any' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at main.cjs:15] |
| `N2-ENDCB-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-ENDCB-02` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-RAW-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-ODD-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `N2-HDR-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-REG-01` | 1/— | `  "exitCode": 0,` | `  "exitCode": 1,` | passing a value of type 'IncomingMessage' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 a… |
| `N2-REG-05` | 1/— | `status abc RangeError ERR_HTTP_INVALID_STATUS_CODE Invalid status code: abc` | ∅ | passing a value of type 'ServerResponse' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 at… |
| `U4-TLS-02` | 1/— | `garbage Error ERR_SSL_WRONG_VERSION_NUMBER true` | ∅ | error listeners whose parameter is not supported (use (err) or ()) is not supported yet [SC1090 at main.cjs:19] |
| `QS-C-2464` | 1/— | `Q1 {"a":["1","2"],"b":"x y z","c":""}` | ∅ | library functions as values (call 'require("querystring").escape' directly) are not supported yet [SC1090 at 2464-qs-require-forms.cjs:10] |
| `H-C-2570` | 1/— | `RangeError\|ERR_OUT_OF_RANGE\|The value of "offset" is out of range. It must be >= 0 && <= 9. Received 10` | `RangeError\|ERR_OUT_OF_RANGE\|The value of "offset" is out of range. It must be >= 0 && <= 9. Received 10` | passing a value of type '() => Uint8Array' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions can cross the boundary) is not supported yet [SC1090 … |
| `H-BUF-03` | 1/— | `  "stderr": "tsinter: unsupported: new Buffer(value, encoding) over a string, an array or an array-like value …` | `  "stderr": "tsinter: unsupported: 'new Buffer' is part of the standard library types but has no scriptc lower…` | new Buffer(value, encoding) over a string, an array or an array-like value is not supported yet (SEMANTICS.md S094) [SC1090] |
| `DCALS-C-2211` | 1/— | `start result=- \| end result=- \| asyncStart result=42 \| asyncEnd result=42` | `start result=- \| end result=- \| asyncStart result=42 \| asyncEnd result=42` | 'assert.strictEqual of 'any' and 'Error' values' is part of the standard library types but has no scriptc lowering yet [SC2020 at 2211-dc-trace-promise.cjs:43] |
| `DCALS-C-2214` | 1/— | `bound counts as active: true` | `bound counts as active: true` | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at 2214-dc-bind-store.cjs:37] |
| `DCALS-03` | 1/— | `undefined same` | ∅ | publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet [SC1090 at main.cjs:37] |
| `DCALS-04` | 1/— | `traceCallback-setImmediate-bad TypeError ERR_INVALID_ARG_TYPE The "callback" argument must be of type function…` | `traceCallback-setImmediate-bad TypeError ERR_INVALID_ARG_TYPE The "callback" argument must be of type function…` | 'Promise<unknown>' values where 'Promise<any>' is expected is not supported yet [SC1090 at main.cjs:43] |
| `DCALS-05` | 1/— | `start:S:one:true` | ∅ | the '===' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include [SC2011 at main.cjs:11] |
| `DCALS-F1` | 1/— | `  "stderr": "tsinter: unsupported: tracePromise without subscribers over a function returning a non-promise is…` | `  "stderr": "tsinter: unsupported: 'Promise<unknown>' values where 'Promise<any>' is expected is not supported…` | 'Promise<unknown>' values where 'Promise<any>' is expected is not supported yet [SC1090 at main.cjs:15] |

### (i) Newly refused or failing to compile: 55, grouped by first diagnostic

Corpus programs were rebuilt with `tsinter build --backend wasm [--dynamic]` on the same checkout and stage to capture the diagnostic text (the harness only reports codes). Quoted names inside the messages are shown as '…' for grouping. Programs listed under a group can also have further diagnostics (the counts after each name).

- **19**: SC1090: an '…' value flowing into a typed '…' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (S115)
  - `1005-json-nested.ts`, `1007-json-rc-stress.ts`, `1551-dyn-receiver-methods.ts`, `1575-unknown-assert-into-record.ts (+1: SC1090)`, `2040-any-bindings.ts`, `2081-destructuring-rest.ts`, `2094-diagnostics-channel.ts`, `2615-nullish-field-record-binding.ts`, `2629-stream-consumers.ts`, `2631-create-require/main.ts (+1: SC1090)`, `2637-create-require-bare/main.ts`, `2700-unknown-typeof-validation.ts`, `908-records-index-signatures.ts (+1: SC1090)`, `909-records-index-json.ts`, `910-records-index-rc-stress.ts`, `911-records-index-dot-access.ts (+1: SC1090)`, `912-unknown-slots.ts (+2: SC1090)`, `914-records-from-entries.ts`, `915-unknown-tostring-eq.ts`
- **9**: harness build refused: SC2020: '…' is part of the standard library types but has no scriptc lowering yet
  - `U1-C-1473 (harness) [util.promisify]`, `U1-C-1573 (harness) [util.promisify]`, `U1-ERR-04 (harness) [util.promisify]`, `U1-VAL-09 (harness) [util.promisify]`, `U1-HYG-01 (harness) [util.promisify]`, `U1-REG-02 (harness) [util.promisify]`, `U1-REG-05 (harness) [util.promisify]`, `U1-REG-11 (harness) [util.promisify]`, `N2-C-2743 (harness) [writeHead with a 'any' headers argument]`
- **7**: SC2020: '…' is part of the standard library types but has no scriptc lowering yet
  - `1473-promisify-execfile.ts [util.promisify]`, `1573-promisify-execfile-env-spread.ts [util.promisify]`, `1812-stream-super-options-forwarding.cjs [new Readable with a non-literal options argument] (+1: SC2020)`, `1983-array-tuple-surfaces.ts [String.raw substitutions of type 'any']`, `2446-performance-global.ts [performance]`, `2561-object-is.ts [Object.is over a dynamic operand]`, `2743-http-option-carry.ts [writeHead with a 'any' headers argument]`
- **4**: harness build refused: SC1090: data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet
  - `URL-C-2644 (harness)`, `URL-HTTP-01 (harness)`, `U4-C-2645 (harness)`, `U4-VERIFY-01 (harness)`
- **3**: SC1090: generic functions as values without a pinned concrete signature (annotate the destination — e.g. '…' — instantiate explicitly ('…'), or call '…' directly) is not supported yet
  - `2551-generics-value-aliases.ts (+5: SC1090,SC2004)`, `2553-generics-signature-bindings.ts`, `2554-generics-frontier-mix.ts`
- **2**: harness build refused: SC1090: an '…' value flowing into a typed '…' slot: typed storage cannot hold an island value, so this would be a COPY, and the compiler cannot see that nothing else holds the value (S115)
  - `DCALS-C-2094 (harness)`, `F-CAUSE-01 (harness)`
- **2**: SC1031: rest elements in destructuring assignment from checked-dynamic sources (collect with .slice() instead) are not supported yet
  - `2082-destructuring-assignment.ts`, `2537-destructuring-assign-member-targets.ts`
- **2**: SC1090: data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet
  - `2644-http-client-url-argument.ts (+2: SC1090)`, `2645-https-client-url-argument.ts (+1: SC1090)`
- **2**: SC1090: the reference to '…' (a binding form with no lowering) is not supported yet
  - `1982-freeze-resolve-passthrough.ts`, `2823-arguments-length-static.ts (+5: SC1090)`
- **2**: SC3001 (expr:jsOp:regexp-source-escape)
  - `1558-any-joins-and-dyn-validation.ts`, `1574-dyn-optional-method-number-keys.ts`
- **1**: SC1090: string methods as values (call '…' directly) are not supported yet
  - `2796-regex-replace-callbacks.ts`
- **1**: SC2020: '…'any'…' is part of the standard library types but has no scriptc lowering yet
  - `1747-stream-for-await-js.cjs [a '_transform' method whose parameter 0 is 'any' where Node passes 'Uint8Array']`
- **1**: SC3001 (expr:jsOp)
  - `2758-math-static-raw.ts`

### (iii) Newly passing: 0

None.
