# Corpus renumbering (INC-26 pass B1, board #148)

The corpus imported at `23d5918` (2026-07-22) carried 48 duplicated program
numbers (45 four-digit + 3 three-digit). Every consumer that keys a program
by full name was unaffected; every consumer that keys by bare number, or
that assumed numbers were unique for a "control by number" reference in a
brief, was ambiguous.

## The rule

For each duplicated number, the file whose FULL NAME sorts first
lexicographically **keeps** the number. The other is **renamed** to the
next free number above the corpus maximum at the time of this pass (2694),
in ascending order starting at 2695, with new numbers assigned in
**lexicographic order of the renamed (old) file names** — the same
mechanical, no-judgement rule both the implementer and the reviewer applied
independently and verified agree bit-for-bit (normalised old→new pair
digest `2f10a699cc39d70541b2ca6cd11eb96756be9f800465801ce7e80536ca65d74a`,
48 pairs). A file's name otherwise never changes. A directory rename moves
every file inside it; their own names are untouched.

**This file is the ORIGINAL record of the mapping.** Every number quoted in
prose elsewhere — a brief, a delta, a plan, a freeze, a register entry — is
a COPY and must be checked against the table below before use (a real
mismatch, corrected in this pass at board #148 itself: an intermediate
numeric-order probe assigned 2712/2705 to two SEMANTICS.md citation
targets; the agreed lexicographic mapping assigns 2709/2702 to them
instead — see the table).

## The mapping (old → new, one line per rename)

| old | new |
|---|---|
| 1520-string-split-static.ts | 2695-string-split-static.ts |
| 1521-string-trim-pad-static.ts | 2696-string-trim-pad-static.ts |
| 1522-spawnsync-options.ts | 2697-spawnsync-options.ts |
| 1523-spawn-options.ts | 2698-spawn-options.ts |
| 1524-catch-narrowing.ts | 2699-catch-narrowing.ts |
| 1525-unknown-typeof-validation.ts | 2700-unknown-typeof-validation.ts |
| 1530-spread-override-completion.ts | 2701-spread-override-completion.ts |
| 1531-process-arch-versions.ts | 2702-process-arch-versions.ts |
| 1532-union-shared-field-read.ts | 2703-union-shared-field-read.ts |
| 1533-path-platform-namespaces.ts | 2704-path-platform-namespaces.ts |
| 1534-union-as-arm-cast.ts | 2705-union-as-arm-cast.ts |
| 1535-union-param-defaults.ts | 2706-union-param-defaults.ts |
| 1536-string-array-sweep.ts | 2707-string-array-sweep.ts |
| 1537-os-release-spawnsync-stdio.ts | 2708-os-release-spawnsync-stdio.ts |
| 1538-math-static-scalar.ts | 2709-math-static-scalar.ts |
| 1539-unknown-truthiness.ts | 2710-unknown-truthiness.ts |
| 1540-void-statement.ts | 2711-void-statement.ts |
| 1541-union-keyed-reads.ts | 2712-union-keyed-reads.ts |
| 1542-record-literal-into-union.ts | 2713-record-literal-into-union.ts |
| 1543-set-server-handles.ts | 2714-set-server-handles.ts |
| 1544-string-matchall.ts | 2715-string-matchall.ts |
| 1561-promise-then.ts | 2716-promise-then.ts |
| 1562-spawn-conditional-spread.ts | 2717-spawn-conditional-spread.ts |
| 1563-string-raw-fold.ts | 2718-string-raw-fold.ts |
| 1564-string-raw.ts | 2719-string-raw.ts |
| 1565-union-element-join.ts | 2720-union-element-join.ts |
| 1571-stdin-set-raw-mode-non-tty.ts | 2721-stdin-set-raw-mode-non-tty.ts |
| 1572-x509-validity-date-gettime.ts | 2722-x509-validity-date-gettime.ts |
| 1573-tdz-scalar-forward-capture.ts | 2723-tdz-scalar-forward-capture.ts |
| 1574-promise-all-tuple-literal.ts | 2724-promise-all-tuple-literal.ts |
| 1630-rmsync-retry-options.cjs | 2725-rmsync-retry-options.cjs |
| 2040-mixin-heritage.ts | 2726-mixin-heritage.ts |
| 2041-mixin-values.ts | 2727-mixin-values.ts |
| 2042-mixin-modules/ (directory: main.ts, zoo.ts) | 2728-mixin-modules/ |
| 2043-mixin-rc-stress.ts | 2729-mixin-rc-stress.ts |
| 2045-parameter-properties.ts | 2730-parameter-properties.ts |
| 2046-objlit-accessors-effects.ts | 2731-objlit-accessors-effects.ts |
| 2047-optional-class-fields.ts | 2732-optional-class-fields.ts |
| 2556-width-hybrid-shapes.ts | 2733-width-hybrid-shapes.ts |
| 2557-width-field-lifts.ts | 2734-width-field-lifts.ts |
| 2558-rejection-events.cjs | 2735-rejection-events.cjs |
| 2582-jsval-routed-keyed-ops.js | 2736-jsval-routed-keyed-ops.js |
| 2583-jsval-routed-calls.js | 2737-jsval-routed-calls.js |
| 2584-union-dyn-collapse.ts | 2738-union-dyn-collapse.ts |
| 2585-unknown-array.ts | 2739-unknown-array.ts |
| 518-promise-void-union-callbacks.ts | 2740-promise-void-union-callbacks.ts |
| 519-promise-union-await-values.ts | 2741-promise-union-await-values.ts |
| 965-unions-retag.ts | 2742-unions-retag.ts |

48 renames (47 single-file + 1 directory containing 2 files), 98 paths total
(49 old + 49 new, git-counted), all `git mv` (blob content byte-identical
at every old path to its value at `1bd256214cee24b6dbca165835ab719a67d67da0`
— the certifier asserts this).

## Two citations left stale by design (residuals)

Both are comments in files this pass does not touch (precedent
`SEMANTICS.md:5255`, an existing stale-but-inert corpus-path comment left
alone by an earlier pass for the same reason: the file is out of scope and
the citation is prose, not a resolved reference the harness reads):

- `packages/compiler/src/backend/llvm/emitter.ts:1136` — a comment naming
  the bare stem `2041-mixin-values` (no extension). `FORBID-PREFIX` for
  this pass.
- `packages/compiler/test/board85-arity-widen.test.ts:32` — a comment
  naming `2557-width-field-lifts.ts`. Not in this pass's `§4` permit set.

Both now point at a name that has moved (`2041-mixin-values.ts` is now
`2727-mixin-values.ts`; `2557-width-field-lifts.ts` is now
`2734-width-field-lifts.ts`). Recorded here as the redirect for a reader
who follows either comment.
