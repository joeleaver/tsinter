# Agent Guide

Guidance for agents (and humans) working on this repository. These conventions apply repo-wide; the docs site under `docs/` additionally has its own conventions in `docs/AGENTS.md`.

## Build and test

```bash
pnpm install && pnpm -r build   # build the workspace
pnpm test:sandbox              # default full gate: plain + sanitized lanes (~4 minutes)
```

Use focused local tests while iterating, then use `pnpm test:sandbox` whenever a
full validation gate is required. It loads Sandbox configuration from the
shell and `.env.local`, runs portable coverage across disposable Linux
Sandboxes, and retains the Darwin-native contracts on macOS. Linux hosts run
their supported native-clang contracts locally; other hosts retain those
checks in the Sandboxes. Both lanes green is the bar before shipping any
change.

On this fork, Vercel Sandbox credentials are generally unavailable — use the
local lanes:

```bash
SCRIPTC_TEST_WORKERS=4 pnpm test                 # plain lane
SCRIPTC_TEST_WORKERS=4 SCRIPTC_SAN=1 pnpm test  # sanitized lane
```

`SCRIPTC_TEST_WORKERS` caps the vitest worker pool so concurrent agents don't
contend for cores; full local suites also queue behind an advisory lock per
lane.

Corpus programs are differential tests against Node: every program runs under Node and as a compiled native binary, and stdout, stderr, and exit codes must match byte-for-byte. A new feature lands with corpus programs that pin its behavior both ways. The wasm lane (`tests/harness/wasm-differential.test.ts`) attempts every corpus program under `--backend wasm` and histograms refusals into the work queue; out-of-tier programs must refuse loudly with a named diagnostic, never miscompile.

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
- `packages/cli` — `tsinter build | run | coverage`.
- `tests/` — the differential corpus, diagnostics snapshots, and the harness.
- `docs/` — the documentation site (standalone pnpm workspace); see `docs/AGENTS.md`.
- `scripts/` — repo tooling, including the release version stamp.

## Releases

Releases are maintainer-run; see [RELEASING.md](./RELEASING.md).
