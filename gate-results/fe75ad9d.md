## Verdict: RED

# Test gate: `u1-shared-dynamic` @ `fe75ad9d`

Run on 2026-11-04 in a cloud VM (4 vCPU, 15 GB) at commit `fe75ad9da77287f7938683371a2d13dc8351b8c5` (HEAD checked and matched), after `bash scripts/cloud-setup.sh` (Node v24.18.1, clang 21.1.8, pnpm 10.34.9). Every stage ran detached under `cleanenv` with `SCRIPTC_TEST_WORKERS=4`. No source was changed. This file is the only commit.

> The branch moved while the gate ran: `5717399`, `132ae26` and `f23fde0` (U1a review fixes) landed after `fe75ad9d`. **These results cover `fe75ad9d` only.** This report is committed on top of the current tip `f23fde0`.

**Why RED:**
1. **13 SILENT failures** (8 distinct programs; wrong output or a null-pointer trap with no diagnostic). All are in stage b's package unit rows. The corpus lanes have none. Details are below.
2. **Both lanes claim 1114/1135**, under the 1115 floor. The 21 missing programs are `module:embedded×3`, the 17 allowed programs, and **`2575-string-destructuring-decl.ts`, which is not on the allowed list**. It refuses with `SC1031 object destructuring of non-record values (the source is dyn-typed) are not supported yet` on both lanes.
3. 298 more NEW failures: 239 compile refusals outside the allowed 17, 6 loud runtime fences, 6 internal-invariant failures, 46 rows that now compile where a test pinned a refusal (all checked against Node; all match except the SILENT `H-EXIT-15`), and one harness bookkeeping row.

## Counts

### Stages

| stage | command | rc | secs | pass / fail / skip | claimed |
|---|---|---|---|---|---|
| a | `pnpm lint`; `tsc --noEmit` compiler (typescript5) + cli | 0 / 0 / 0 | 22 / 3 / 1 | clean | — |
| b | `vitest run packages` | 1 | 612 | 4517 / **263** / 24 | — |
| c | `SCRIPTC_WASM_REFUSALS=1 vitest run tests/harness/wasm-differential.test.ts` | 1 | 548 | 1525 / **43** / 4 | **wasm tier: 1114/1135** |
| d | `vitest run tests/harness/wasmnative-differential.test.ts tests/harness/wasmnative-host-rows.test.ts` | 1 | 608 | 1334 / **53** / 2 | **wasm-native lane: 1114/1135** |
| e | `vitest run tests/harness/{diagnostics,errors,dyncheck}.test.ts` | 1 | 65 | 171 / **1** / 0 | — |
| f | `SCRIPTC_NO_CACHE=1 vitest run` | 1 | 1617 | 8337 / 417 / 35 → **357 after excluding my probes** | wasm 1114/1135; wasm-native 1114/1135 |

Recorded lines (stage c):
- `wasm tier: 1114/1135 corpus programs claimed; first refusals: module:embedded×3`
- `wasm work queue (2 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3`

Stage d: `wasm-native lane: 1114/1135 corpus programs claimed; refusals by reason: module:embedded×3`

Notes on stage f: it ran while my temporary probe files (`packages/compiler/test/zz-gate-probe-*.test.ts`, untracked and since deleted) were on disk, so it picked them up. Their 60 failures are excluded. The other 357 failures are **exactly** the union of the b, c, d and e failures. Nothing new appears, and stage d's three timing rows pass in f.

### Classification (unique failures across stages)

| category | b | c | d | e | total |
|---|---|---|---|---|---|
| ALLOWED: the 17 corpus programs, each refusing by name on both lanes | — | 17 | 17 | — | 17 programs |
| ALLOWED-derived: `*-C-NNNN` harness rows rerunning an allowed program (`U1-C-1473`, `U1-C-1573`, `N2-C-2743`, `URL-C-2644`, `U4-C-2645`), same named refusal | — | 5 | — | — | 5 |
| expected `tier floor` / `claim floor` mismatch (lists 18 programs: the 17 plus **2575**) | — | 1 | 1 | — | 2 |
| known: #124 `U3-ORD-01`, `U3-BIG-01` (pass when re-run alone) | — | 2 | — | — | 2 |
| known: #123 `U4-R-10`, `SECURITY 2-3`; #116 `O23-B1` | — | — | 3 | — | 3 |
| flaky: `U1-RUN-06 (#1)`, `U3-TWO-02 (#117)`, `G1-SIG-06 (#193)`, which fail under load and pass alone and in stage f | — | — | 3 | — | 3 (not counted as NEW) |
| no-IPv6 rows: skip with a named reason (`[environment: no IPv6 (binding ::1 failed: EAFNOSUPPORT)]`, `[environment: 'localhost' does not resolve to two usable addresses (families [4], IPv6 no)]`) | — | — | skip | — | ok |
| **NEW: SILENT** | **13** | 0 | 0 | 0 | **13** |
| NEW: LOUD RUNTIME FENCE | 6 | 0 | 0 | 0 | 6 |
| NEW: COMPILE REFUSAL | 193 | 18 | 28 | 0 | 239 |
| NEW: now compiles where a test pinned a refusal; output equals Node (stale pin) | 45 | 0 | 0 | 1 | 46 |
| NEW: internal invariant (no program output involved) | 6 | 0 | 0 | 0 | 6 |
| NEW: harness bookkeeping (`KNOWN is exact`: stale `U1-REG-02`, `U1-REG-05`, `U1-REG-11`, `N1-REG-01`, because those rows now refuse at compile time) | 0 | 0 | 1 | 0 | 1 |
| **NEW total** | 263 | 18 | 29 | 1 | **311** |

Re-runs: I re-ran every stage-b failure alone, one file at a time, filtered with `-t` to the failing names: all 263 failed again. I also re-ran each non-corpus failing row of stages c and d alone. Only `U3-ORD-01`, `U3-BIG-01` (known #124) and the 3 flaky rows above passed. I compiled each of the 18 refusing corpus programs on both lanes to read its diagnostics.

### The allowed 17: refusal names (identical on wasm and wasm-native)

| program | refusal |
|---|---|
| 1473-promisify-execfile.ts | SC2020 'util.promisify' is part of the standard library types but has no scriptc lowering yet |
| 1573-promisify-execfile-env-spread.ts | SC2020 'util.promisify' … no scriptc lowering yet |
| 1574-dyn-optional-method-number-keys.ts | SC2011 values of type 'any' run in the embedded dynamic engine, which this build does not include |
| 1982-freeze-resolve-passthrough.ts | SC1090 the reference to 'arguments' (a binding form with no lowering) is not supported yet |
| 2082-destructuring-assignment.ts | SC1031 rest elements in destructuring assignment from checked-dynamic sources (collect with .slice() instead) are not supported yet |
| 2446-performance-global.ts | SC2020 'performance' is part of the standard library types but has no scriptc lowering yet |
| 2537-destructuring-assign-member-targets.ts | SC1031 rest elements in destructuring assignment from checked-dynamic sources … |
| 2551-generics-value-aliases.ts | SC1090 generic functions as values without a pinned concrete signature … (+ SC2004 inherit) |
| 2553-generics-signature-bindings.ts | SC1090 generic functions as values without a pinned concrete signature … |
| 2554-generics-frontier-mix.ts | SC1090 generic functions as values without a pinned concrete signature … |
| 2578-jsval-into-unknown-rows.ts | SC1100 operators on 'unknown' values are not supported yet |
| 2630-stream-consumers-errors.ts | SC1090 'Promise<unknown>' values where 'Promise<any>' is expected is not supported yet (+ SC2004) |
| 2644-http-client-url-argument.ts | SC1090 data listeners whose parameter is not supported (use (chunk: Buffer) or ()) is not supported yet |
| 2645-https-client-url-argument.ts | SC1090 data listeners whose parameter is not supported … |
| 2743-http-option-carry.ts | SC2020 'writeHead with a 'any' headers argument' is part of the standard library types but has no scriptc lowering yet |
| 2796-regex-replace-callbacks.ts | SC1090 string methods as values (call 'toUpperCase' directly) are not supported yet |
| 2823-arguments-length-static.ts | SC1090 the reference to 'arguments' (a binding form with no lowering) is not supported yet (×7) |
| **2575-string-destructuring-decl.ts (NOT allowed)** | **SC1031 object destructuring of non-record values (the source is dyn-typed) are not supported yet** |

## SILENT items (13 rows, 8 programs)

Each item gives the test, the lane, Node's output against ours, the stderr, and the exit code. For the wasm lane I captured stderr and stdout with a temporary copy of the row that catches the trap. The real harness throws the `RuntimeError` out of `runWasm`. The `RuntimeError: dereferencing a null pointer` line is the trap text with no `tsinter:` diagnostic in front of it.

### S1. `wasm-any-array-shared.test.ts` › `H-EXIT-15 fn07e-record-index` (wasm **and** wasm-native): **wrong output, exit 0**

The row expects a refusal. The program now compiles and prints the wrong answer. A `Record<string, number[]>` view of an `any` object is a copy: the push does not reach the shared object.

```ts
// @dynamic
const o: any = { m: { a: [1] } };
const m: Record<string, number[]> = o.m;
m["a"].push(2);
console.log(`${o.m.a.length}`);
```

| | stdout | stderr | exit |
|---|---|---|---|
| Node | `2` | — | 0 |
| tsinter wasm | `1` | — | 0 |
| tsinter wasm-native | `1` | — | 0 |

The sibling exits `H-EXIT-17/18/19` and `H-FRESH-03f` now compile and **match** Node. Only the `Record<string, T[]>` exit is wrong.

### S2. `wasm-undef-observers.test.ts` › `102-json-dyn-root` (wasm **and** wasm-native): **wrong output, exit 0**

```ts
const o: any = JSON.parse("{}");
const j = JSON.stringify(o.x);
console.log(typeof j, j === undefined, j, JSON.stringify(o), JSON.stringify(o.x, null, 2));
const fnBox: any = JSON.parse("[1]");
console.log(JSON.stringify(fnBox), JSON.stringify(JSON.parse("null")));
```

```diff
- undefined true undefined {} undefined
+ string false undefined {} undefined
  [1] null
```
Both exit 0 with empty stderr, on both lanes. `JSON.stringify(undefined-valued any)` comes back typed as a string, not as `undefined`.

### S3. `wasm-emitter.test.ts` › `S020: f.name is the BOX SITE's binding and f.length the DECLARED count` (wasm): **wrong output, exit 0**

Third stdout line: pinned `[] []`, got `[] [f]`. Node prints `[inner] [passed]` (per the row's own comment), so the new output matches neither Node nor the S020 pin. Caveat: `[f]` may match S020's stated rule ("the box site's binding": `takesFn`'s `f as unknown`), so this one may only need a re-pin. It is listed as SILENT because the output changed, it still differs from Node, and the test fails.

```diff
  [alias] [realName]
  [got]
- [] []
+ [] [f]
  2 2 2 3
  6 7 5 8
```

### S4. `wasm-undef-observers.test.ts` › `101-isarray` (wasm **and** wasm-native): **null-pointer trap, no diagnostic**

```ts
const aa: number[][] = []; const a = aa[0];
const one = [1];
console.log(Array.isArray(a), Array.isArray(aa[1]), Array.isArray(one));
const b = aa[1]!;
console.log(Array.isArray(b));
const [first] = [aa[0]];
const { p } = { p: aa[1] };
console.log(Array.isArray(first), Array.isArray(p));
function f(x: number[]) { return Array.isArray(x); }
console.log(f(aa[2]), f([3]));
```

| | stdout | stderr | exit |
|---|---|---|---|
| Node | `false false true` / `false` / `false false` / `false true` | — | 0 |
| tsinter (both lanes) | `false false true` / `false` | `RuntimeError: dereferencing a null pointer` | 1 |

wasm trap stack: `%view.0.len ← %w.dyn.fnThunk:func()=>f64 ← %w.dyn.viewCall0 ← %w.dyn.viewLen ← %w.dyn.viewArrSnap ← %w.dyn.arrOf ← %w.dyn.check:array<f64> ← %init.0`. From the stack, an absent (`undefined`) `number[]` element reaches a dyn view, and the view's length read dereferences null.

### S5. `wasm-undef-observers.test.ts` › `rv-q2-record-observers` (wasm **and** wasm-native): **null-pointer trap, no diagnostic**

wasm trap stack: `%w.dyn.viewObjSnap ← %w.dyn.objOf ← %w.dyn.spreadSource ← %fn3`. The stack points to the same null-view read, this time on a record spread source. Node prints the `spread {}` line and 12 more. We stop after `entries`.

### S6. `wasm-review-repros.test.ts` › `r4-destructure-spread` (wasm **and** wasm-native): **null-pointer trap, no diagnostic**

wasm trap stack: `%view.1.len ← %w.dyn.fnThunk ← %w.dyn.viewCall0 ← %w.dyn.viewLen ← %w.dyn.viewArrSnap ← %w.dyn.arrOf ← %w.dyn.iterPack ← %fn1`. Node catches a `TypeError` at every step (`a1 CAUGHT TypeError aa[0] is not iterable`, …). We print the first line only, then trap.

### S7. `wasm-review-repros.test.ts` › `r4-reads-everywhere` (wasm **and** wasm-native): **null-pointer trap, no diagnostic**

wasm trap stack: `%view.4.len ← … ← %w.dyn.arrOf ← %w.insp.dyn ← %w.insp.dynS ← %util.fmtarg.2`. `console.log` of an undefined typed-array slot through the dyn inspector. Output stops after `c2`, where Node continues with `c3 undefined`.

### S8. `wasm-review-repros.test.ts` › `r4-e01-exists` (wasm-native; the row is fs-host and has no wasm-lane run): **null-pointer trap, no diagnostic**

| | stdout | stderr | exit |
|---|---|---|---|
| Node | `false` ×4 | DEP0187 deprecation warning (the row compares stdout and exit only) | 0 |
| tsinter wasm-native | `false` ×2 | `RuntimeError: dereferencing a null pointer` | 1 |

### Full outputs for S4–S8


<details><summary><code>r4-destructure-spread</code> — wasm</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
s2b [ 0, '{}', undefined ]
a1 CAUGHT TypeError aa[0] is not iterable
d1 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d2 CAUGHT TypeError Cannot destructure property 'x' of 'r' as it is undefined.
d3 CAUGHT TypeError Cannot destructure property 'x' of 'get(...)' as it is undefined.
d4 CAUGHT TypeError Cannot destructure property 'x' of 'm.get(...)' as it is undefined.
d5 CAUGHT TypeError Cannot destructure property 'y' of 'cs[0]' as it is undefined.
d6 CAUGHT TypeError Cannot destructure property 'y' of 'c' as it is undefined.
d7 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d8 CAUGHT TypeError Cannot read properties of undefined (reading 'x')
d9 CAUGHT TypeError Cannot destructure 'rs[0]' as it is undefined.
d10 CAUGHT TypeError Cannot destructure property 'x' of 'o.r' as it is undefined.
d11 CAUGHT TypeError Cannot destructure property 'x' of 'undefined' as it is undefined.
d12 CAUGHT TypeError Cannot destructure property 'x' of 'undefined' as it is undefined.
d13 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d14 CAUGHT TypeError undefined is not iterable (cannot read property Symbol(Symbol.iterator))
d15 CAUGHT TypeError Cannot destructure property 'x' of '.for' as it is undefined.
d16 CAUGHT TypeError Cannot read properties of undefined (reading 'x')
d17 CAUGHT TypeError Cannot destructure property 'x' of 'rs[i]' as it is undefined.
d18 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d19 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d20 CAUGHT TypeError Cannot destructure property 'x' of '(intermediate value)(intermediate value)(intermediate value)' as it is undefined.
```
- tsinter stdout:
```
s2b [ 0, '{}', undefined ]
```


</details>

<details><summary><code>r4-reads-everywhere</code> — wasm</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
a1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a3 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
a6 CAUGHT TypeError Cannot read properties of undefined (reading '3')
a7 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
a8 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
b1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
b2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
b3 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
b4 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
c1 CAUGHT TypeError Cannot read properties of undefined (reading '1')
c2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
c3 undefined
c4 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c6 undefined
c7 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c8 CAUGHT TypeError Cannot read properties of undefined (reading 'undefined')
c9 CAUGHT TypeError Cannot read properties of undefined (reading 'undefined')
c10 CAUGHT TypeError Cannot read properties of undefined (reading 'NaN')
c11 CAUGHT TypeError Cannot read properties of undefined (reading '1e+21')
c12 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c13 CAUGHT TypeError Cannot read properties of undefined (reading '0')
d1 CAUGHT TypeError Cannot read properties of undefined (reading 'tags')
d2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
d5 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
d6 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d7 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d8 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d9 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d10 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d11 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d12 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d13 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d14 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d15 undefined
d16 true
d17 undefined
d18 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
e1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e4 0
e5 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
e6 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f4 CAUGHT TypeError Cannot read properties of undefined (reading 'c')
ag Cannot read properties of undefined (reading 'id')
rej TypeError: Cannot read properties of undefined (reading 'id')
tm Cannot read properties of undefined (reading 'id')
```
- tsinter stdout:
```
a1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a3 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
a6 CAUGHT TypeError Cannot read properties of undefined (reading '3')
a7 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
a8 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
b1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
b2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
b3 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
b4 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
c1 CAUGHT TypeError Cannot read properties of undefined (reading '1')
c2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
```


</details>

<details><summary><code>r4-destructure-spread</code> — wasm-native</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm-native): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
s2b [ 0, '{}', undefined ]
a1 CAUGHT TypeError aa[0] is not iterable
d1 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d2 CAUGHT TypeError Cannot destructure property 'x' of 'r' as it is undefined.
d3 CAUGHT TypeError Cannot destructure property 'x' of 'get(...)' as it is undefined.
d4 CAUGHT TypeError Cannot destructure property 'x' of 'm.get(...)' as it is undefined.
d5 CAUGHT TypeError Cannot destructure property 'y' of 'cs[0]' as it is undefined.
d6 CAUGHT TypeError Cannot destructure property 'y' of 'c' as it is undefined.
d7 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d8 CAUGHT TypeError Cannot read properties of undefined (reading 'x')
d9 CAUGHT TypeError Cannot destructure 'rs[0]' as it is undefined.
d10 CAUGHT TypeError Cannot destructure property 'x' of 'o.r' as it is undefined.
d11 CAUGHT TypeError Cannot destructure property 'x' of 'undefined' as it is undefined.
d12 CAUGHT TypeError Cannot destructure property 'x' of 'undefined' as it is undefined.
d13 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d14 CAUGHT TypeError undefined is not iterable (cannot read property Symbol(Symbol.iterator))
d15 CAUGHT TypeError Cannot destructure property 'x' of '.for' as it is undefined.
d16 CAUGHT TypeError Cannot read properties of undefined (reading 'x')
d17 CAUGHT TypeError Cannot destructure property 'x' of 'rs[i]' as it is undefined.
d18 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d19 CAUGHT TypeError Cannot destructure property 'x' of 'rs[0]' as it is undefined.
d20 CAUGHT TypeError Cannot destructure property 'x' of '(intermediate value)(intermediate value)(intermediate value)' as it is undefined.
```
- tsinter stdout:
```
s2b [ 0, '{}', undefined ]
```


</details>

<details><summary><code>r4-reads-everywhere</code> — wasm-native</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm-native): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
a1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a3 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
a6 CAUGHT TypeError Cannot read properties of undefined (reading '3')
a7 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
a8 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
b1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
b2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
b3 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
b4 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
c1 CAUGHT TypeError Cannot read properties of undefined (reading '1')
c2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
c3 undefined
c4 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c6 undefined
c7 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c8 CAUGHT TypeError Cannot read properties of undefined (reading 'undefined')
c9 CAUGHT TypeError Cannot read properties of undefined (reading 'undefined')
c10 CAUGHT TypeError Cannot read properties of undefined (reading 'NaN')
c11 CAUGHT TypeError Cannot read properties of undefined (reading '1e+21')
c12 CAUGHT TypeError Cannot read properties of undefined (reading '0')
c13 CAUGHT TypeError Cannot read properties of undefined (reading '0')
d1 CAUGHT TypeError Cannot read properties of undefined (reading 'tags')
d2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
d5 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
d6 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d7 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d8 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d9 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d10 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d11 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d12 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d13 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d14 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
d15 undefined
d16 true
d17 undefined
d18 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
e1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
e4 0
e5 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
e6 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f3 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
f4 CAUGHT TypeError Cannot read properties of undefined (reading 'c')
ag Cannot read properties of undefined (reading 'id')
rej TypeError: Cannot read properties of undefined (reading 'id')
tm Cannot read properties of undefined (reading 'id')
```
- tsinter stdout:
```
a1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a2 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
a3 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a4 CAUGHT TypeError Cannot read properties of undefined (reading 'name')
a5 CAUGHT TypeError Cannot read properties of undefined (reading '0')
a6 CAUGHT TypeError Cannot read properties of undefined (reading '3')
a7 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
a8 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
b1 CAUGHT TypeError Cannot read properties of undefined (reading 'id')
b2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
b3 CAUGHT TypeError Cannot read properties of undefined (reading 'length')
b4 CAUGHT TypeError Cannot read properties of undefined (reading 'nest')
c1 CAUGHT TypeError Cannot read properties of undefined (reading '1')
c2 CAUGHT TypeError Cannot read properties of undefined (reading '3')
```


</details>

<details><summary><code>r4-e01-exists</code> — wasm-native</summary>


- Node: exit 0, stderr: "(node:2066) [DEP0187] DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated\n(Use `node --trace-deprecation ...` to show where the warning was created)\n"
- tsinter (wasm-native): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
false
false
false
false
```
- tsinter stdout:
```
false
false
```


</details>

<details><summary><code>101-isarray</code> — wasm</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
false false true
false
false false
false true
```
- tsinter stdout:
```
false false true
false
```


</details>

<details><summary><code>102-json-dyn-root</code> — wasm</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm): exit 0, stderr: ""
- Node stdout:
```
undefined true undefined {} undefined
[1] null
```
- tsinter stdout:
```
string false undefined {} undefined
[1] null
```


</details>

<details><summary><code>rv-q2-record-observers</code> — wasm</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
keys E Cannot convert undefined or null to object
values E Cannot convert undefined or null to object
entries E Cannot convert undefined or null to object
spread {}
spread2 { c: 1 }
assign { a: 0, b: '' }
arrspread E as[0] is not iterable
forof E as[0] is not iterable
hasOwn E Cannot convert undefined or null to object
eq true
nullish 9
optchain undefined
concat r=undefined
ab [ 1, 2, undefined, undefined ]
stringify-arr [null,null]
stringify-rec {}
```
- tsinter stdout:
```
keys E Cannot convert undefined or null to object
values E Cannot convert undefined or null to object
entries E Cannot convert undefined or null to object
```


</details>

<details><summary><code>101-isarray</code> — wasm-native</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm-native): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
false false true
false
false false
false true
```
- tsinter stdout:
```
false false true
false
```


</details>

<details><summary><code>102-json-dyn-root</code> — wasm-native</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm-native): exit 0, stderr: ""
- Node stdout:
```
undefined true undefined {} undefined
[1] null
```
- tsinter stdout:
```
string false undefined {} undefined
[1] null
```


</details>

<details><summary><code>rv-q2-record-observers</code> — wasm-native</summary>


- Node: exit 0, stderr: ""
- tsinter (wasm-native): exit 1, stderr: "RuntimeError: dereferencing a null pointer\n"
- Node stdout:
```
keys E Cannot convert undefined or null to object
values E Cannot convert undefined or null to object
entries E Cannot convert undefined or null to object
spread {}
spread2 { c: 1 }
assign { a: 0, b: '' }
arrspread E as[0] is not iterable
forof E as[0] is not iterable
hasOwn E Cannot convert undefined or null to object
eq true
nullish 9
optchain undefined
concat r=undefined
ab [ 1, 2, undefined, undefined ]
stringify-arr [null,null]
stringify-rec {}
```
- tsinter stdout:
```
keys E Cannot convert undefined or null to object
values E Cannot convert undefined or null to object
entries E Cannot convert undefined or null to object
```

</details>


## LOUD RUNTIME FENCES (6 rows)

| row | lane | Node | tsinter |
|---|---|---|---|
| `wasm-undef-observers` › `105-arg-order` | wasm, wasm-native | exit 0; prints `arg b`, then a caught `TypeError The "path" argument must be of type string…`, and so on to `x/y` | exit 1, stdout empty, stderr `tsinter: unsupported: expected string, got number [SC1100]` (+ `RuntimeError: unreachable`). A fence now fires where the row previously matched Node. |
| `wasm-review-repros` › `q-narrow` | wasm, wasm-native | — | the fence still fires, but its text lost the path: pinned `tsinter: unsupported: expected number at $, got string [SC1100]`, got `tsinter: unsupported: expected number, got string [SC1100]` |
| `wasm-emitter` › `S009: as on an unknown value validates…` | wasm | — | same text loss as `q-narrow` (`at $` missing) |
| `wasm-emitter` › `dyn↔bytes crossing: a non-u8 typed array refuses loudly…` | wasm, wasm-native (row is wasm only) | `Uint32Array(1) [ 1 ]` | used to be a compile refusal (SC1101). Now compiles, and at run time prints `tsinter: unsupported: inspecting a typed array held in a dynamic value is not supported yet [SC1090]`, exit 1 |

## NEW COMPILE REFUSALS outside stage b

Stage c (wasm-differential), 18:
- `2575-string-destructuring-decl.ts`: SC1031 (above). The `tier floor` mismatch lists it as a regression.
- `U1-ERR-04`, `U1-VAL-09`, `U1-HYG-01`, `U1-REG-02`, `U1-REG-05`, `U1-REG-11`: `SC2020 'util.promisify' … no scriptc lowering yet`. These are non-corpus sources hitting the same refusal as allowed 1473/1573.
- `URL-HTTP-01`, `U4-VERIFY-01`: `SC1090 data listeners whose parameter is not supported (use (chunk: Buffer) or ())`.
- `F-FX-01`: `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into '{ arr: (number | string)[]; n: number; s: string }': it would be a COPY … (SEMANTICS.md S125)`.
- `F-FX-02`, `F-TAG-01`: `SC2020 'ArrayBuffer.byteLength' … no scriptc lowering yet`.
- `F-BODY-01`: `SC1100 passing 'unknown' values where 'Promise<string>' is expected` (+ SC2004).
- `F-FX-03`, `F-HDR-01`, `F-SIG-01`, `F-REQ-01`, `F-HEV-01`: `SC3001 the wasm backend does not support this construct yet (fn:async:await-dyn)`.

Stage d (wasm-native), 28:
- `2575-string-destructuring-decl.ts` (SC1031). The `claim floor` mismatch lists it.
- `U1-ERR-04`, `U1-VAL-09`, `U1-HYG-01`, `U1-REG-02`, `U1-REG-05`, `U1-REG-11`: `util.promisify` SC2020.
- `N1-REG-01`: `SC1090 error listeners whose parameter is not supported (use (err) or ())`.
- `U4-VERIFY-01`: SC1090 data listeners.
- `user-fetch (static)`: SC1090 S125 checked-into copy. `response-surface (static)`, `wasm/string-tags.ts`: SC2020 `ArrayBuffer.byteLength`. `wasm/body-readers.ts`: SC1100 `Promise<string>`.
- `fn:async:await-dyn` (SC3001): `proxy-optin`, `wasm/abort-signal.ts`, `wasm/headers.ts`, `wasm/requests.ts`, `wasm/with-signal.ts`, `SECURITY B1`, `SECURITY B2`, `B3`, `SECURITY 1-4`, `SECURITY 5`, `SECURITY 4, 6`, `S117 (h)`, `O23-M1`, `notes: a redirect to a URL with credentials…`, `fetch refuses every #332 certificate…`.
- Known `O23-B1` (#116) now also stops at compile time with the same `fn:async:await-dyn` SC3001.

`fn:async:await-dyn` is the largest new refusal family on the host rows. None of the fetch/TLS/SECURITY host rows listed above compile any more.

## INTERNAL INVARIANTS (6 rows, stage b)

- `wasm-bytes-validate` › `every function with a BYTES arm emits a VALID module` and the 4 `wasm-bytes-flag` rows: the directly built helper module fails `WebAssembly.validate`: `CompileError: Compiling function #16:"%w.dyn.strictEq" failed: expected 1 elements on the stack for return, found 0 @+1170`. This would fail loudly at module load, not silently.
- `wasm-island-engine` › `E0: a module that never reaches the engine carries none of it`: the plain and `--dynamic` builds of an engine-free program are no longer byte-identical (`Buffer.compare` = 1).

## NOW COMPILES where a test pinned a refusal (46 rows; output equals Node)

I compiled each of these on wasm and wasm-native and ran it against Node with a temporary, uncommitted harness copy. Each matches Node byte for byte, so these are stale pins, not miscompiles:
- `wasm-dyn-copies` U0 rows on both lanes (19 × 2): `out-identity`, `roundtrip-orig-write`, `in-any-write`, `in-later-push`, `in-later-write`, `in-object-slot`, `in-nested-shared`, `in-param-write`, `in-dynamic-call-write`, `in-identity`, `in-pushed-into-dynamic`, `in-constructor-param-write`, `in-virtual-method-write`, `in-async-result-then`, `in-async-result-await`, `in-generator-yield-for-of`, `in-generator-yield-next`, `in-call-through-value-write`, `in-callback-param-write`.
- `wasm-any-array-shared`: `H-EXIT-17`, `H-EXIT-18`, `H-EXIT-19`, `H-FRESH-03f`, `H-S2` (Node `5`; the row pinned a holes fence).
- `wasm-dynsmalls-u5` `R07` (`TE t` / `not TE`). `wasm-qs` `QS-N-03` (`object`, both variants).
- Stage e: `dyncheck` › `a NAMED record into an any slot is a deep copy…` now prints `2 2`, which is Node's output (the row pinned an SC1090 refusal).

(`H-EXIT-15` was in this group but does **not** match Node. See S1.)

## Stage-b NEW items: full list

#### Stage b — LOUD RUNTIME FENCE (6)

| file | test | first error line |
|---|---|---|
| wasm-emitter.test.ts | S009: `as` on an unknown value validates, and each failure ends the program naming the path (GH #86 review, S122) | AssertionError: expected 'tsinter: unsupported: expected number…' to be 'tsinter: unsupported: expected number…' // Object.is equality |
| wasm-emitter.test.ts | dyn↔bytes crossing: a non-u8 typed array refuses loudly, not a silent miscompile or a compiler crash | AssertionError: expected true to be false // Object.is equality |
| wasm-review-repros.test.ts | the GH #86 review's repros (wasm lane) > q-narrow | AssertionError: expected 'tsinter: unsupported: expected number…' to be 'tsinter: unsupported: expected number…' // Object.is equality |
| wasm-review-repros.test.ts | the GH #86 review's repros (wasm-native lane) > q-narrow | AssertionError: expected 'tsinter: unsupported: expected number…' to be 'tsinter: unsupported: expected number…' // Object.is equality |
| wasm-undef-observers.test.ts | GH #101-#105: undefined-slot observers (wasm lane vs Node) > 105-arg-order | RuntimeError: unreachable |
| wasm-undef-observers.test.ts | GH #101-#105: undefined-slot observers (wasm-native lane vs Node) > 105-arg-order | AssertionError: expected { stdout: '', …(2) } to deeply equal { …(3) } |

#### Stage b — INTERNAL INVARIANT (6)

| file | test | first error line |
|---|---|---|
| wasm-bytes-flag.test.ts | dyn.ts toStr: the isBuffer flag forces UTF-8 decode vs comma-join — measured against Node (String(Buffer.from([104,105,3 | AssertionError: expected false to be true // Object.is equality |
| wasm-bytes-flag.test.ts | json.ts putDyn: the isBuffer flag forces {"type":"Buffer","data":[...]} vs the numeric-keyed object form — measured agai | AssertionError: expected false to be true // Object.is equality |
| wasm-bytes-flag.test.ts | inspect.ts's dyn walker: the isBuffer flag forces bufferForm's <Buffer aa bb cc> hex form vs the array-grid Uint8Array(N | AssertionError: expected false to be true // Object.is equality |
| wasm-bytes-flag.test.ts | inspect.ts's dyn walker: the depth boundary, BOTH flavors, at the exact recurse values a real nested object would pass — | AssertionError: expected false to be true // Object.is equality |
| wasm-bytes-validate.test.ts | dyn.ts/json.ts/inspect.ts: every function with a BYTES arm emits a VALID module (direct, bypassing the frontend) | AssertionError: expected false to be true // Object.is equality |
| wasm-island-engine.test.ts | E0: the engine artifact and the merger > a module that never reaches the engine carries none of it (one memory, no table | AssertionError: expected 1 to be +0 // Object.is equality |

#### Stage b — NOW COMPILES (stale refusal pin; output = Node) (45)

| file | test | first error line |
|---|---|---|
| wasm-any-array-shared.test.ts | H-EXIT-17 an unmutated read-only exit refuses too refuses by name, identically on wasm and c | Error: H-EXIT-17 compiled on wasm but was expected to refuse |
| wasm-any-array-shared.test.ts | H-EXIT-18 a JSON.parse result held in a binding first refuses by name, identically on wasm and c | Error: H-EXIT-18 compiled on wasm but was expected to refuse |
| wasm-any-array-shared.test.ts | H-EXIT-19 an 'as' cast is an exit too refuses by name, identically on wasm and c | Error: H-EXIT-19 compiled on wasm but was expected to refuse |
| wasm-any-array-shared.test.ts | H-FRESH-03f a typed-composite-element spread still refuses (its parts would be shared) | Error: H-FRESH-03f compiled on wasm but was expected to refuse |
| wasm-any-array-shared.test.ts | H-S2 a write past an island array's length (Node leaves holes) refuses by name on wasm; the native engine has holes | AssertionError: expected null to be an instance of RuntimeError |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > out-identity | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > roundtrip-orig-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-any-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-later-push | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-later-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-object-slot | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-nested-shared | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-dynamic-call-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-identity | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-pushed-into-dynamic | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-constructor-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-virtual-method-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-async-result-then | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-async-result-await | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-generator-yield-for-of | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-generator-yield-next | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-call-through-value-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-callback-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > out-identity | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > roundtrip-orig-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-any-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-later-push | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-later-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-object-slot | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-nested-shared | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-dynamic-call-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-identity | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-pushed-into-dynamic | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-constructor-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-virtual-method-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-async-result-then | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-async-result-await | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-generator-yield-for-of | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-generator-yield-next | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-call-through-value-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dyn-copies.test.ts | U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-callback-param-write | AssertionError: expected true to be false // Object.is equality |
| wasm-dynsmalls-u5.test.ts | R07 DYNCHECK: not lifted: an instanceof TypeError narrow on unknown stays a front-end refusal (board #189) | Error: R07 compiled but was expected to refuse |
| wasm-qs.test.ts | qs.parse's null-prototype result refuses by name where it would show > QS-N-03 a parse result becoming a dynamic value r | AssertionError: expected true to be false // Object.is equality |

#### Stage b — COMPILE REFUSAL (193)

Grouped by the first error line (every one is a named compile-time diagnostic or a test expecting refusal A that got named refusal B):

- **39×** `passing a value of type 'Promise<any>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unio`
  - wasm-adopt.test.ts › AD01 RESOLVE: Promise.resolve of an any-held dyn promise answers that promise: no job
  - wasm-adopt.test.ts › AD02 RESOLVE: an async function returning an any-held dyn promise adopts it with Node's tw
  - wasm-adopt.test.ts › AD03 RESOLVE: new Promise resolved with an any-held dyn promise adopts it with Node's two 
  - wasm-adopt.test.ts › AD07 RESOLVE: a PENDING any-held promise settled inside o1: resolve, await, then and retur
  - wasm-adopt.test.ts › AD09 RESOLVE: a promise resolved with itself through an any rejects with Node's chaining-c
  - wasm-adopt.test.ts › AD15 RESOLVE: a resolve function resolved with an any-held promise is already resolved: a 
  - wasm-adopt.test.ts › AD17 RESOLVE: a captured resolver called again in a later job after resolving with an any-
  - wasm-adopt.test.ts › IS01 ISLAND: a rejected any-held promise's then passes the rejection through to an unhandl
  - wasm-adopt.test.ts › IS02 ISLAND: then then catch on a rejected any-held promise
  - wasm-adopt.test.ts › IS04 ISLAND: catch directly on a rejected any-held promise
  - wasm-adopt.test.ts › IS05 ISLAND: an island then handler returning an any-held promise: adopted with Node's two
  - wasm-adopt.test.ts › IS06 ISLAND: await of an any-held dyn promise beside five observers: Node's one job (board
  - wasm-adopt.test.ts › IS07 ISLAND: control: a plain island then on a fulfilled any-held promise
  - wasm-adopt.test.ts › IS08 ISLAND: finally and a two-handler then on an any-held promise
  - wasm-adopt.test.ts › IS09 ISLAND: a two-handler then and finally on rejected and fulfilled any-held promises, a
  - wasm-adopt.test.ts › TY01 TYPED: an async function's typed return of an any-held promise adopts it with Node's 
  - wasm-adopt.test.ts › TY02 TYPED: a typed new Promise resolved with an any-held promise adopts it (board #234)
  - wasm-adopt.test.ts › TY03 TYPED: the adopted value is cast to the typed slot: a mismatch ends the program at ad
  - wasm-adopt.test.ts › TY04 TYPED: an any-held REJECTED promise returned from a typed async function rejects it w
  - wasm-adopt.test.ts › TY06 TYPED: a settler already resolved by adoption ignores a later resolve
  - wasm-adopt.test.ts › TY09 TYPED: Promise.withResolvers' typed resolve adopts an any-held promise
  - wasm-adopt.test.ts › TY11 TYPED: a typed settler adopting an any-held rejected promise rejects with the reason
  - wasm-adopt.test.ts › TY13 TYPED: a PENDING any-held promise settled by a timer, adopted by a typed return
  - wasm-adopt.test.ts › TY14 TYPED: control: a typed NON-settler closure called with an any-held promise keeps the
  - wasm-adopt.test.ts › TY15 TYPED: a checked cast of an unknown-held promise returned from a typed async function
  - wasm-adopt.test.ts › TY16 TYPED: a typed settler resolved with a checked cast of an unknown-held promise adopts
  - wasm-adopt.test.ts › TY17 TYPED: the adopted value fails the checked cast: the dynCheck fence ends the program 
  - wasm-adopt.test.ts › TY18 TYPED: control: a checked cast of an unknown-held number returns directly, no job
  - wasm-adopt.test.ts › TY19 TYPED: NOT-LIFTED: a typed then handler's `: number` return of an any-held promise ke
  - wasm-async-u4.test.ts › Z09 ISLAND: an island then handler returns a typed number promise: adopted with Node's two
  - wasm-async-u4.test.ts › Z09b ISLAND: an island then handler returns a typed record promise (board #182)
  - wasm-async-u4.test.ts › Z13 ISLAND: control: a dyn promise through an island then
  - wasm-async-u4.test.ts › Z14 ISLAND: control: a dyn promise awaited as any
  - wasm-async-u4.test.ts › Z15 ISLAND: control: a rejected dyn promise awaited as any
  - wasm-async-u4.test.ts › ISL01 ISLAND: an island then handler returns a dyn promise: adopted with Node's two jobs (
  - wasm-async-u4.test.ts › ISL02 ISLAND: await of an any-held dyn promise awaits the promise itself (board #184)
  - wasm-emitter.test.ts › JSON.stringify over a dyn ROOT: the tree's own kinds drive the walk
  - wasm-inspect.test.ts › the dyn walker > a promise inside a dyn tree fences (SEMANTICS.md S030) — bare: the fence 
  - wasm-inspect.test.ts › the dyn walker > a promise inside a dyn tree fences (SEMANTICS.md S030) — nested: the fenc
- **32×** `'Object.defineProperties' is part of the standard library types but has no scriptc lowering yet`
  - wasm-dyn-defineprops.test.ts › semantics: non-object target throws Node's own TypeError text
  - wasm-dyn-defineprops.test.ts › semantics: nullish descs throws ToObject's TypeError text
  - wasm-dyn-defineprops.test.ts › semantics C-3: a non-nullish, non-object descs is a NO-OP — returns target, copies nothing
  - wasm-dyn-defineprops.test.ts › semantics C-4: a non-object-like descriptor value throws with the ToString(value) text
  - wasm-dyn-defineprops.test.ts › semantics C-4: an ARRAY descriptor value is object-like — no throw, defines undefined (FUN
  - wasm-dyn-defineprops.test.ts › semantics S061: an accessor descriptor (get/set PRESENCE) is a named fence that ends the p
  - wasm-dyn-defineprops.test.ts › semantics S061: a CALLABLE get on a FUNC target fences identically — presence is the trigg
  - wasm-dyn-defineprops.test.ts › semantics S062: a non-enumerable OBJ-target write refuses by name (Node succeeds silently)
  - wasm-dyn-defineprops.test.ts › semantics S062's own positive control: enumerable:true on an OBJ target succeeds
  - wasm-dyn-defineprops.test.ts › surface: get/hasOwn/keys over an enumerable vs a hidden FUNC property
  - wasm-dyn-defineprops.test.ts › LOG rendering: named-1prop
  - wasm-dyn-defineprops.test.ts › LOG rendering: anon-1prop
  - wasm-dyn-defineprops.test.ts › LOG rendering: mustCall-name-length
  - wasm-dyn-defineprops.test.ts › LOG rendering: name-redefined-to-a-different-string
  - wasm-dyn-defineprops.test.ts › LOG rendering: sorted-mixed-keys (LOG: insertion order)
  - wasm-dyn-defineprops.test.ts › LOG rendering: circular-self
  - wasm-dyn-defineprops.test.ts › LOG rendering: circular-hidden-is-invisible
  - wasm-dyn-defineprops.test.ts › LOG rendering: a FUNC-with-props beyond the default display depth collapses to bare [Funct
  - wasm-dyn-defineprops.test.ts › LOG rendering: the SAME FUNC-with-props AT the depth boundary still renders fully
  - wasm-dyn-defineprops.test.ts › CF rendering: assert.deepStrictEqual sorts keys and expands multi-line, unlike LOG
  - wasm-dyn-defineprops.test.ts › CF rendering: mustCall's own shape (non-enumerable name/length) renders with NO block
  - wasm-dyn-defineprops.test.ts › descs THREE arms: nullish throws, non-nullish-non-object no-ops, non-empty strings THROW n
  - wasm-dyn-defineprops.test.ts › descs: an ARRAY is a valid descs map — [] no-ops, [{value,enumerable}] defines key "0"
  - wasm-dyn-defineprops.test.ts › descs: a FUNCTION descs bag no-ops when bare, but processes its OWN enumerable own propert
  - wasm-dyn-defineprops.test.ts › descs: a typed array (BYTES) throws on its first element — elements are raw numbers, never
  - wasm-dyn-defineprops.test.ts › ONE FIXTURE discriminates BOTH surface mutations (H-4, both halves) — enumerable:true visi
  - wasm-dyn-defineprops.test.ts › render key order: integer-like keys ascend FIRST and render QUOTED, then strings in insert
  - wasm-dyn-defineprops.test.ts › render key order near-misses: "01" and "-1" are NOT integer-like — insertion order, no reo
  - wasm-dyn-defineprops.test.ts › mustCall no-block pin, POSITIVE and NEGATIVE together (one test): hidden name/length rende
  - wasm-dyn-defineprops.test.ts › F-3 threshold-straddle, LOG: SAME 5-prop entry set is single-line on an OBJ receiver, mult
  - wasm-dyn-defineprops.test.ts › F-3 regression guard, CF: the SAME 5-prop entry set — CF already breaks multi-line on BOTH
  - wasm-dyn-defineprops.test.ts › F-3 companion, CF-vs-LOG key order DIFFERENCE on one fixture: LOG uses JS insertion order 
- **17×** `passing a value of type 'Promise<number>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/u`
  - wasm-adopt.test.ts › AD05 RESOLVE: Promise.resolve of an any-held TYPED number promise answers that promise (a 
  - wasm-adopt.test.ts › AD06 RESOLVE: an async function returning an any-held TYPED number promise adopts it (a ga
  - wasm-adopt.test.ts › AD08 RESOLVE: a REJECTED any-held typed promise through return, new Promise, Promise.resol
  - wasm-adopt.test.ts › AD13 RESOLVE: an island then handler re-returning its own receiver, beside an async functi
  - wasm-adopt.test.ts › AD16 RESOLVE: already resolved to an any-held TYPED promise, a later reject is ignored (a 
  - wasm-adopt.test.ts › TY07 TYPED: a boxed TYPED promise (gated module) adopted through both a typed return and a
  - wasm-adopt.test.ts › TY12 TYPED: a settler that escaped into a variable, resolved with its own promise: Node's 
  - wasm-async-u4.test.ts › D25 DYNPROMISE: a module mixing a typed same-type Promise.race with an any-held await (the
  - wasm-async-u4.test.ts › D25b DYNPROMISE: a module mixing a typed same-type Promise.race with the reaction trio (th
  - wasm-async-u4.test.ts › Z01 ISLAND: a typed number promise through an island then
  - wasm-async-u4.test.ts › Z04 ISLAND: a rejected typed promise through an island then reaches the unhandled-rejectio
  - wasm-async-u4.test.ts › Z05 ISLAND: await of an any-held typed number promise awaits the promise itself, Node's on
  - wasm-async-u4.test.ts › Z08 ISLAND: await of an any-held rejected typed promise (board #184)
  - wasm-async-u4.test.ts › Z17 ISLAND: catch directly on an any-held rejected typed promise (board #177)
  - wasm-async-u4.test.ts › T01 RESOLVE: an async function returning an any that holds a typed promise adopts it (boar
  - wasm-async-u4.test.ts › T02 RESOLVE: Promise.resolve of an any that holds a typed promise answers that promise (bo
  - wasm-async-u4.test.ts › T03 RESOLVE: control: the same module shapes with a non-promise any
- **14×** `expected 'SC1090:a dynamic (\'unknown\', \'any\…' to match /…/'any\[\]' so both sides share one value, or copy explicitly where the copy is meant: \[\.\.\.x\] or \{ \.\.\.x \}`
  - wasm-any-array-shared.test.ts › H-EXIT-01 a01-field-exit refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-02 a02-return-exit refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-03 a05-map-value refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-04 a09-generator refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-05 a13-param-chain refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-06 a15-ctor-param refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-07 a16-method refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-08 a17-callback refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-09 a25-element-exit refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-10 a26-for-of-exit refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-11 a27-record-exit-field-write refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-13 a31-param-reassign-alias refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-14 fn07c-elem-alias refuses by name, identically on wasm and c
  - wasm-any-array-shared.test.ts › H-EXIT-16 board #259's own shape refuses by name, identically on wasm and c
- **11×** `expected 'SC1090:a dynamic (\'unknown\', \'any\…' to match /SC1090:an '(any\|unknown)' value flowi…/`
  - wasm-any-array-shared.test.ts › H-FRESH-02a freshness is proven by provenance, not spelling: s02-custom-map.ts refuses by 
  - wasm-any-array-shared.test.ts › H-FRESH-02b freshness is proven by provenance, not spelling: s04-fnvar-reassigned.ts refus
  - wasm-any-array-shared.test.ts › H-FRESH-02c freshness is proven by provenance, not spelling: s05-virtual.ts refuses by nam
  - wasm-any-array-shared.test.ts › H-FRESH-02d freshness is proven by provenance, not spelling: s16-objmethod-reassigned.ts r
  - wasm-any-array-shared.test.ts › H-FRESH-02e freshness is proven by provenance, not spelling: s21b-user-response.ts refuses
  - wasm-any-array-shared.test.ts › H-FRESH-02f freshness is proven by provenance, not spelling: s27b-json-shadow.ts refuses b
  - wasm-any-array-shared.test.ts › H-FRESH-02g freshness is proven by provenance, not spelling: s12-custom-sort.ts refuses by
  - wasm-any-array-shared.test.ts › H-UNK-01a an 'unknown' value leaving into typed storage follows S115 (d): u01-unknown-cast
  - wasm-any-array-shared.test.ts › H-UNK-01b an 'unknown' value leaving into typed storage follows S115 (d): u04-unknown-para
  - wasm-any-array-shared.test.ts › H-UNK-01c an 'unknown' value leaving into typed storage follows S115 (d): u05-unknown-guar
  - wasm-any-array-shared.test.ts › H-UNK-01d an 'unknown' value leaving into typed storage follows S115 (d): s10-objassign.ts
- **10×** `expected [ Array(1) ] to deeply equal [ Array(1) ]`
  - wasm-adopt.test.ts › SP03 SPINE: NOT-LIFTED: the spine's copying bridge in a gated module beside a typed same-t
  - wasm-async-u4.test.ts › G17 GEN: B-i: a void yield as a call operand
  - wasm-async-u4.test.ts › H08 HOISTVOID: B-i: a void await as a call argument
  - wasm-async-u4.test.ts › H09 HOISTVOID: B-i: two void call arguments
  - wasm-async-u4.test.ts › H10 HOISTVOID: B-i: void awaits as call arguments with side effects
  - wasm-symbol-u1.test.ts › B-i gate 1 (const s: any = Symbol('d')) — plain and dynamic, with a number twin
  - wasm-symbol-u1.test.ts › B-i gate 2 (const t: symbol = ...; const s: any = t) — plain and dynamic, with a number tw
  - wasm-symbol-u1.test.ts › B-i gate 3 (f(Symbol('d')) where f(v: any)) — plain and dynamic, with a number twin
  - wasm-symbol-u1.test.ts › B-i gate 4 (const a: any[] = [Symbol('d')]) — DYNAMIC ONLY; plain fences on `any[]` itself
  - wasm-symbol-u1.test.ts › B-i gate 5 (const u: unknown = Symbol('d')) — mode-invariant, with a number twin
- **8×** `'in' on 'any' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; narrow first: check a discriminant field, or compare with '!== undefined'/'!`
  - wasm-island-a.test.ts › I-TYPED-02 case 0/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 1/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 2/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 3/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 4/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 5/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 6/0: every reader that would walk or convert a dynamic typed array refuses
  - wasm-island-a.test.ts › I-TYPED-02 case 6/1: every reader that would walk or convert a dynamic typed array refuses
- **5×** `passing a value of type 'Promise<{ a: number; b: string }>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-saf`
  - wasm-adopt.test.ts › AD10 RESOLVE: an any-held TYPED record promise read by await, a typed then and Promise.all
  - wasm-adopt.test.ts › AD11 RESOLVE: an any-held TYPED record promise read through Promise.race and Promise.all (
  - wasm-adopt.test.ts › AD14 RESOLVE: a dyn Promise.race over an any-held TYPED record promise beside a typed same
  - wasm-async-u4.test.ts › Z03 ISLAND: a typed record promise through an island then
  - wasm-async-u4.test.ts › Z07 ISLAND: await of an any-held typed record promise (board #184)
- **4×** `the wasm backend does not support this construct yet (fn:async:await-dyn); build with the LLVM backend (the default) or the reference C backend (--backend c)`
  - wasm-fetch.test.ts › FX-01 a body larger than the module's first poll buffer: the module grows the buffer to th
  - wasm-fetch.test.ts › FX-02 a FAIL after the HEAD rejects the body reader with the host's error, its cause carry
  - wasm-fetch.test.ts › FX-03 a host record out of the contract's shapes (a BODY before any HEAD) is the named tra
  - wasm-native.test.ts › the wasm-native lane's host, end to end against Node > the host keeps nothing the program 
- **3×** `passing a value of type 'Promise<string>' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/u`
  - wasm-adopt.test.ts › AD12 RESOLVE: any-held TYPED string, boolean and void promises through Promise.resolve and
  - wasm-async-u4.test.ts › Z02 ISLAND: a typed string promise through an island then
  - wasm-async-u4.test.ts › Z06 ISLAND: await of an any-held typed string promise (board #184)
- **3×** `'util.promisify' is part of the standard library types but has no scriptc lowering yet (SC2020)`
  - wasm-host-cp-u1.test.ts › INC-28 U1 child_process — forced-host rows (exec family) > F-06 promisified execFile sends
  - wasm-host-cp-u1.test.ts › INC-28 U1 child_process — forced-host rows (exec family) > F-24b the exec family with a st
  - wasm-host-cp-u1.test.ts › INC-28 U1 child_process — forced-host rows (exec family) > F-23c an errno outside the tabl
- **3×** `publishing 'any' messages (messages cross as dyn values — JSON-safe data, Uint8Array, errors, and functions) are not supported yet (SC1090)`
  - wasm-host-process-p3.test.ts › P3 forced-host: the warning surface's grammar > a non-string, non-Error warning throws ERR
  - wasm-host-process-p3.test.ts › P3 forced-host: the warning surface's grammar > a non-string type throws ERR_INVALID_ARG_T
  - wasm-host-process-p3.test.ts › P3 forced-host: the warning surface's grammar > a non-string code throws ERR_INVALID_ARG_T
- **2×** `'assert.ifError over 'any' values' is part of the standard library types but has no scriptc lowering yet`
  - wasm-assert-core.test.ts › assert.ifErrorDyn's composite-kind (ARR) arm: a bare, deliberately silent sentinel trap (P
  - wasm-assert-core.test.ts › assert.ifErrorDyn's composite-kind (OBJ without '%error') arm: the SAME named trap, a plai
- **2×** `{"ok":false,"diagnostics":["SC2020 'util.promisify' is part of the standard library types but has no scriptc lowering yet"]}: expected false to be true // Object.is equality`
  - wasm-childproc-u1.test.ts › INC-28 U1 child_process — host-free rows > N-PRE-5 a module reaching only cp.execCapture i
  - wasm-childproc-u1.test.ts › INC-28 U1 child_process — host-free rows > N-SHAPE-03 the promisified execFile helper with
- **2×** `[{"code":"SC2020","message":"'the event 'e' with conflicting argument types' is part of the standard library types but has no scriptc lowering yet"},{"code":"SC2020","message":"'the event 'e' with con`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > in-listener-write
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > in-listener-wri
- **2×** `SC3001 the wasm backend does not support this construct yet (fn:async:await-dyn); build with the LLVM backend (the default) or the reference C backend (--backend c)`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > ok-caught-cast-beside-
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > ok-caught-cast-
- **2×** `using an 'any' value where 'null \| Error' is expected (an 'any' value can only exit to numbers, strings, booleans, JSON-safe records/arrays/unions, and 'T \| undefined' over those) is not supported y`
  - wasm-dynsmalls-u5.test.ts › R03 DYNCHECK: a narrowed Error returned from a function keeps its identity
  - wasm-dynsmalls-u5.test.ts › R04b DYNCHECK: SEMANTICS.md S025: a parsed object carrying the reserved error key narrows 
- **2×** `expected [ …(2) ] to deeply equal [ …(2) ]`
  - wasm-dynsmalls-u5.test.ts › R08 DYNCHECK: not lifted: instanceof a user class on unknown stays a named front-end refus
  - wasm-symbol-u1.test.ts › B-i gate 9 (Reflect.ownKeys over a symbol-computed key) — both modes name SC1090 + SC2020
- **2×** `'in' on 'any' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; narrow first: check a discriminant field, or compare with '!== undefined'/'!=`
  - wasm-island-a.test.ts › A2-KEYS-01 the checked-dynamic key surfaces over island getters, linked objects and string
  - wasm-island-a.test.ts › F1-RE-05 lastIndex is an own member of an island RegExp, for in and Object.hasOwn alike
- **2×** `SC2020 'Number of any values' is part of the standard library types but has no scriptc lowering yet`
  - wasm-stdlib-members.test.ts › Step 2B: stdlib members (wasm lane vs Node) > nb1-number-union
  - wasm-stdlib-members.test.ts › Step 2B: stdlib members (wasm-native lane vs Node) > nb1-number-union
- **2×** `SC1090 this property form in an 'any'-typed object literal (only 'name: value', shorthand names, methods, and get accessors are supported) is not supported yet`
  - wasm-undef-observers.test.ts › GH #101-#105: undefined-slot observers (wasm lane vs Node) > 104-error-and-keys
  - wasm-undef-observers.test.ts › GH #101-#105: undefined-slot observers (wasm-native lane vs Node) > 104-error-and-keys
- **1×** `expected 'passing a value of type \'Promise<any…' to contain 'an \'any\' value flowing into a typed…'`
  - wasm-adopt.test.ts › TY08 TYPED: a record-typed destination adopting an `any`-held value refuses at compile tim
- **1×** `expected 'SC1090:assignment to non-variables ar…' to match /…/'any\[\]' so both sides share one value, or copy explicitly where the copy is meant: \[\.\.\.x\] or \{ \.\.\.x \}`
  - wasm-any-array-shared.test.ts › H-EXIT-12 a29-length-write refuses by name, identically on wasm and c
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into 'number[]': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy's type,`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > ok-parse-cast-write
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into 'number[]': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy's type`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > ok-parse-member-cast
- **1×** `SC1090 a function crossing into a dynamic value, its parameter 'o' typed '{ a: number }': it would be a COPY where JavaScript shares the object, and the program writes to dynamic`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm lane vs Node) > ok-cb-param-dyn-push-d
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into 'number[]': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy'`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > ok-parse-cast-w
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into 'number[]': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy`
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > ok-parse-member
- **1×** `SC1090 a function crossing into a dynamic value, its parameter 'o' typed '{ a: number }': it would be a COPY where JavaScript shares the object, and the program writes to `
  - wasm-dyn-copies.test.ts › U0: observable dynamic-crossing copies refuse (wasm-native lane vs Node) > ok-cb-param-dyn
- **1×** `passing a value of type 'TypeError' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unions `
  - wasm-dynsmalls-u5.test.ts › R02 DYNCHECK: the narrowed value is the thrown instance itself (identity across two crossi
- **1×** `passing a value of type 'DOMException' into dynamically-executed ('any'-typed) code (only numbers, strings, booleans, typed arrays, URLs, undefined/null-armed unions, and JSON-safe records/arrays/unio`
  - wasm-dynsmalls-u5.test.ts › R05 DYNCHECK: a DOMException narrowed as an Error
- **1×** `expected [ …(2) ] to deeply equal [ Array(1) ]`
  - wasm-dynsmalls-u5.test.ts › R09 DYNCHECK: not lifted: a checked cast of unknown to Error stays a named front-end refus
- **1×** `a dynamic ('unknown', 'any' or 'object') value checked into '{ id: string; items: { name: string; price: number }[] }': it would be a COPY where JavaScript shares the object, and the program wri`
  - wasm-emitter.test.ts › S009: a composite `as` names the PATH it failed at — each failure ends the program (GH #86
- **1×** `the '===' operator on 'any'-typed values runs in the embedded dynamic engine, which this build does not include`
  - wasm-emitter.test.ts › dyn invoke: callbacks see (elem, i, receiver), and sort is the spec's
- **1×** `expected false to be true // Object.is equality`
  - wasm-emitter.test.ts › classes: increment 22 stage A lifts the gate for the emitter root; stage B lifts it again 
- **1×** `expected [ 'SC2020' ] to deeply equal [ 'SC1101', 'SC2020' ]`
  - wasm-emitter.test.ts › assert.match (INC-24 P6, error-arm reachability): an any-typed flow (both arguments any, a
- **1×** `SC1090 a '{ x: number }' value where '{ x: number; y: null \| undefined }' is expected: the slot would hold a COPY where JavaScript shares the object, and the program writes to values of the slot's`
  - wasm-eval-order.test.ts › GH #117/#119: evaluation order (wasm lane vs Node) > l7-object-assign
- **1×** `SC2020 'Object.assign with spread sources and a later argument that may write' is part of the standard library types but has no scriptc lowering yet \| SC2020 'Object.assign with spread sou`
  - wasm-eval-order.test.ts › GH #117/#119: evaluation order (wasm lane vs Node) > n1-assign-spread-sources
- **1×** `SC1090 a '{ x: number }' value where '{ x: number; y: null \| undefined }' is expected: the slot would hold a COPY where JavaScript shares the object, and the program writes to values of t`
  - wasm-eval-order.test.ts › GH #117/#119: evaluation order (wasm-native lane vs Node) > l7-object-assign
- **1×** `SC2020 'Object.assign with spread sources and a later argument that may write' is part of the standard library types but has no scriptc lowering yet \| SC2020 'Object.assign with s`
  - wasm-eval-order.test.ts › GH #117/#119: evaluation order (wasm-native lane vs Node) > n1-assign-spread-sources
- **1×** `SC1090 a '{ [key: string]: string[] \| number \| string \| undefined }' value converted to a dynamic ('unknown', 'any' or 'object') value: it would be a COPY where JavaScript shares the object, and th`
  - wasm-qs.test.ts › qs.parse's null-prototype result refuses by name where it would show > QS-N-04 the same di
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into '{ a: number; note: string }': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy`
  - wasm-review-repros.test.ts › the GH #86 review's repros (wasm lane) > r4-s15x-no-other
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into '{ a: number; note: string }': it would be a COPY where JavaScript shares the object, and the program writes to values of`
  - wasm-review-repros.test.ts › the GH #86 review's repros (wasm-native lane) > r4-s15x-no-other
- **1×** `the reference to 'arguments' (a binding form with no lowering) is not supported yet`
  - wasm-silent-batch.test.ts › T164A ARGSLEN: a fixed-arity TypeScript method folds arguments.length to its declared coun
- **1×** `a '{ a: number }' value where '{ a: number; b: null \| undefined }' is expected: the slot would hold a COPY where JavaScript shares the object, and the program writes to values of the slot's type, and`
  - wasm-silent-batch.test.ts › T230A PRESENCE: a widened literal's phantom optional members: inspect, and the crossing in
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into '{ x: number }': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy's type, and `
  - wasm-undef-observers.test.ts › GH #101-#105: undefined-slot observers (wasm lane vs Node) > 101-delete-assign
- **1×** `SC1090 a dynamic ('unknown', 'any' or 'object') value checked into '{ x: number }': it would be a COPY where JavaScript shares the object, and the program writes to values of the copy's t`
  - wasm-undef-observers.test.ts › GH #101-#105: undefined-slot observers (wasm-native lane vs Node) > 101-delete-assign


## Method notes

- Every probe I used (copies of `wasm-dyn-copies`, `wasm-review-repros`, `wasm-undef-observers` and `wasm-bytes-validate` rows that log Node and tsinter output, catch traps, or run refused-pin rows against Node, plus a corpus-diagnostic dump) was a temporary, untracked file under `packages/compiler/test/` and has been deleted. None was committed.
- My probes ran with `SCRIPTC_TEST_WORKERS=1` under `nice`, alongside stages c, d and f. That load is the likely cause of the three timing flakes in stage d. They pass alone and in stage f.
