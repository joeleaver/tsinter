# tsinter — agent entry point

Read [AGENTS.md](./AGENTS.md) first — build/test commands, repo layout, and
the testing contract live there. Two rules worth repeating because they are
absolute:

1. **Node is the oracle.** Corpus programs must match Node byte-for-byte;
   out-of-tier constructs refuse loudly with a named diagnostic — never
   miscompile, never fall back silently.
2. **Divergences are registered first.** Any deliberate difference from
   Node's observable behavior gets an `S###` entry in
   [SEMANTICS.md](./SEMANTICS.md) *before* the change merges.

Current focus: the WasmGC backend (`packages/compiler/src/backend/wasm/`).
The work queue is the census histogram from
`tests/harness/wasm-differential.test.ts` — run it to see what to build next.
