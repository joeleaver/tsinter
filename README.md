# tsinter

**TypeScript, sintered into WebAssembly.**

tsinter is a tiered TypeScript → WebAssembly compiler. Fully-typed code is
compiled ahead-of-time to compact [WasmGC](https://github.com/WebAssembly/gc)
modules with near-native performance; code the static tier cannot lower will
fall back to an embedded interpreter tier so that *everything runs* and typing
is a performance upgrade, not an entry requirement. The compiler itself is
pure TypeScript — no native toolchain — so it runs anywhere JS runs, including
inside a browser worker.

> **Status: pre-alpha, day one.** The frontend and typed IR work (inherited —
> see Provenance). The WasmGC backend currently *refuses every program*, by
> design: its refusal diagnostics are machine-readable, and the differential
> harness histograms them into the work queue we are building from. Nothing is
> usable yet.

## Why

Nothing else occupies this spot (we looked hard):

- [Javy](https://github.com/bytecodealliance/javy) runs real JS in wasm, but
  only as QuickJS bytecode — no static tier, no types.
- [AssemblyScript](https://assemblyscript.org) compiles a TS-*like* dialect —
  a lookalike language with different semantics, no fallback for real TS.
- [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS) embeds
  10 MB of SpiderMonkey per module.
- [scriptc](https://github.com/vercel-labs/scriptc) has the right compiler
  architecture — real tsc frontend, typed IR — but targets native
  executables, with no wasm story and no embedding API.

tsinter's bet: **real tsc in front, a typed IR in the middle, WasmGC out the
back** — and where the static tier must refuse a construct, it refuses with a
named diagnostic instead of silently meaning something different.

## Architecture

```
TypeScript source
      │  tsc (real TypeScript typechecker, standard tsconfig)
      ▼
 typed IR        ← validated on every compile; version-fenced; serializable;
      │            generics monomorphized, unions tagged, closures explicit
      ▼
 WasmGC backend  ← this repo's new work (packages/compiler/src/backend/wasm)
      ▼
 .wasm module    ← standalone; exports = your exported functions
```

Semantics are pinned by a **differential corpus with Node as the oracle** —
no golden files. Every corpus program must behave byte-for-byte like Node, or
be refused with a named diagnostic. Deliberate divergences are recorded in
[`SEMANTICS.md`](SEMANTICS.md); code may not cite an entry that
does not exist.

## Provenance

tsinter is an Apache-2.0 fork of
[vercel-labs/scriptc](https://github.com/vercel-labs/scriptc) (forked at
v0.0.18). What we keep, and what changes:

| | scriptc | tsinter |
|---|---|---|
| Frontend | tsc → typed IR | **kept** (upstream tracked for fixes) |
| IR + validator | typed, versioned, runtime-free | **kept** |
| Test method | differential vs Node, no golden files | **kept** |
| Backends | LLVM/C → native executables | **replaced**: WasmGC |
| Runtime | C (refcount, fibers, kqueue, mbedTLS) | **replaced**: host GC, state-machine async |
| Output | native binaries | **standalone wasm modules** |
| Node platform APIs (fs, net, http…) | supported | out of scope — refused with named diagnostics |

The native backends and C runtime are still present in-tree during the
transition (they serve as an executable semantics reference and enable
three-way differential testing: Node vs native vs wasm). They will be removed
once the wasm lane stands alone.

## License

[Apache-2.0](LICENSE). Original work copyright the scriptc authors (Vercel
Labs); modifications copyright tsinter contributors.
