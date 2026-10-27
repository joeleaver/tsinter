# Agent Guide

Guidance for agents (and humans) working on this repository. These conventions apply repo-wide; the docs site under `docs/` additionally has its own conventions in `docs/AGENTS.md`.

## Build and test

```bash
pnpm install && pnpm -r build                    # build the workspace
SCRIPTC_TEST_WORKERS=4 pnpm test                 # plain lane
SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test  # sanitized lane
```

Use focused local tests while iterating. Wasm-only changes (under
`packages/compiler/src/backend/wasm/`, its tests, `SEMANTICS.md`, or
`tests/harness/wasm-differential.test.ts`) gate on build + `tsc --noEmit`, the
non-harness suite and the wasm census; anything else also needs the full run.
(`pnpm test:sandbox` is upstream's Vercel Sandbox gate; its credentials are not
available on this fork.)

`SCRIPTC_TEST_WORKERS` caps the vitest worker pool so concurrent agents don't
contend for cores; full local suites also queue behind an advisory lock per
lane.

Corpus programs are differential tests against Node: every program runs under Node and as a compiled native binary, and stdout, stderr, and exit codes must match byte-for-byte. A new feature lands with corpus programs that pin its behavior both ways. The wasm lane (`tests/harness/wasm-differential.test.ts`) attempts every corpus program under `--backend wasm` and histograms refusals into the work queue; out-of-tier programs must refuse loudly with a named diagnostic, never miscompile. Adding a corpus program may require re-recording `packages/compiler/test/ts7/baselines/order-parity.json` (always for `.js`/`.mjs`/`.cjs` and `*/main.ts` entries), and the full plain lane is what proves it.

## Semantics register

Any deliberate divergence from Node's observable behavior gets a numbered
`S###` entry in [`SEMANTICS.md`](./SEMANTICS.md) **before** it merges. Code
comments cite entries as `SEMANTICS.md S###`; citing a nonexistent entry is a
bug. (Upstream scriptc comments cite bare-numbered entries from a register
that was never shipped — those citations are historical, not references into
our file.)

## Where things live

- `packages/compiler` — the frontend (tsc API to IR), the typed IR with validator and serializer, the WasmGC backend (`src/backend/wasm`, this fork's main work), and the LLVM and C backends (transitional: kept as executable semantics references until the wasm lane stands alone).
- `packages/runtime` — the C runtime compiled into native binaries (transitional, same caveat).
  `packages/runtime/src/wasmnative` is the native runner: the wasm module translated to C (`backend/wasm2c.ts`) plus its collector, C host and driver — the `wasm-native` lane, `tests/harness/wasmnative-differential.test.ts`.
- `packages/cli` — `tsinter build | run | coverage`.
- `tests/` — the differential corpus, diagnostics snapshots, and the harness.
- `docs/` — the documentation site (standalone pnpm workspace); see `docs/AGENTS.md`.
- `scripts/` — repo tooling, including the release version stamp.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
