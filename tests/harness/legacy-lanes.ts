/* The legacy C and LLVM lanes are not tested by default.
 *
 * The C and LLVM backends and their C runtime (packages/runtime/src/scr_*,
 * `--backend c|llvm`, the flagless default build, library mode, FFI) are
 * transitional: they are deleted at milestone N4, and until then they may
 * break without blocking anything (Joe, 2026-11-02). The suite tests the
 * WasmGC lanes (wasm, wasm-native) and the frontend.
 *
 * This file is the ONE place that says what that means:
 *   - LEGACY_ONLY: files whose job is building or running C/LLVM binaries,
 *     or the C runtime. vitest.config.ts excludes them.
 *   - LEGACY_MIXED: files that keep running but skip their C/LLVM cases
 *     (each file gates those cases on LEGACY_LANES, or filters its lane
 *     list through `modernLanes`).
 * `SCRIPTC_LEGACY_LANES=1` brings every file and case back. Paths are
 * relative to the repo root. */

export const LEGACY_LANES = process.env["SCRIPTC_LEGACY_LANES"] === "1";

/** Excluded unless SCRIPTC_LEGACY_LANES=1 — one line of reason each. */
export const LEGACY_ONLY: Readonly<Record<string, string>> = {
  // ── tests/harness ──────────────────────────────────────────────────────
  "tests/harness/differential.test.ts": "the corpus on the C-reference lane (--backend c)",
  "tests/harness/llvm-differential.test.ts": "the corpus on the LLVM lane",
  "tests/harness/linux-differential.test.ts": "C-lane cross builds run in a Linux container (env-gated, SCRIPTC_LINUX)",
  "tests/harness/windows-differential.test.ts": "C-lane cross builds run on the Windows box (env-gated, SCRIPTC_WIN)",
  "tests/harness/library-cross.test.ts": "library-mode archives (c/llvm emission) cross-built per target (env-gated, SCRIPTC_CROSS)",
  "tests/harness/library-mode.test.ts": "library mode emits c/llvm archives only (the K fixtures)",
  "tests/harness/library-contract.test.ts": "library mode's contract sidecar over c/llvm archives",
  "tests/harness/library-int.test.ts": "library mode's i64/u64 slots over c/llvm archives",
  "tests/harness/library-asyncfree.test.ts": "library mode's async_free gate, built through --backend c",
  "tests/harness/ffi.test.ts": "outbound native FFI links into c/llvm binaries only",
  "tests/harness/server.test.ts": "net/http server fixtures as default-lane (llvm/c) binaries",
  "tests/harness/fetch.test.ts": "fetch fixtures as default-lane (llvm/c) binaries; the wasm lanes run them in wasm-differential and wasmnative-host-rows",
  "tests/harness/node-test.test.ts": "node:test fixtures on the C lane (spec-reporter pins written against it)",
  "tests/harness/npm.test.ts": "npm fixtures as default-lane --dynamic binaries (the C island)",
  "tests/harness/vercel-e2e.test.ts": "the real vercel CLI as a default-lane --dynamic binary (also needs a local install)",
  "tests/harness/prettier-e2e.test.ts": "the real prettier CLI as a default-lane --dynamic binary (also needs a local install)",
  "tests/harness/island.test.ts": "the C runtime's island bridge, fibers and emitted-C size classes",
  "tests/harness/inheritance.test.ts": "greps the emitted C for vtable machinery",
  // ── packages/compiler/test ─────────────────────────────────────────────
  "packages/compiler/test/emit-c.test.ts": "the C emitter over hand-built IR",
  "packages/compiler/test/llvm-runtime-abi.test.ts": "LLVM declares against the C runtime's scr_runtime.h",
  "packages/compiler/test/url-base-native.test.ts": "S096's URL-base gap on the c and llvm lanes",
  "packages/compiler/test/native-regex-engine.test.ts": "the C runtime's scr_regex_engine.h against the wasm engine",
  "packages/compiler/test/native-regex-engine-drift.test.ts": "the C runtime's scr_regex_engine.h is a fresh rendering",
  // ── packages/runtime/test: the C runtime's own unit tests ──────────────
  "packages/runtime/test/array.test.ts": "C runtime unit test (scr_array.c)",
  "packages/runtime/test/bytes.test.ts": "C runtime unit test (scr_bytes.c, scr_zlib.c)",
  "packages/runtime/test/closure.test.ts": "C runtime unit test (scr_closure.c)",
  "packages/runtime/test/inspect.test.ts": "C runtime unit test (scr_inspect.c)",
  "packages/runtime/test/json.test.ts": "C runtime unit test (scr_json.c)",
  "packages/runtime/test/lib.test.ts": "C runtime unit test (scr_lib.c)",
  "packages/runtime/test/map.test.ts": "C runtime unit test (scr_map.c)",
  "packages/runtime/test/number.test.ts": "C runtime unit test (scr_number.c)",
  "packages/runtime/test/path.test.ts": "C runtime unit test (scr_path.c)",
  "packages/runtime/test/process-tail.test.ts": "C runtime unit test (scr_lib.c process surface)",
  "packages/runtime/test/regex.test.ts": "C runtime unit test (scr_regex.c)",
  "packages/runtime/test/runtime.test.ts": "C runtime smoke (smoke.c)",
  "packages/runtime/test/string.test.ts": "C runtime unit test (scr_string.c)",
  "packages/runtime/test/tonumber.test.ts": "C runtime unit test (scr_number.c ToNumber)",
  "packages/runtime/test/url.test.ts": "C runtime unit test (scr_url.c)",
};

/** Kept, with their C/LLVM cases skipped unless SCRIPTC_LEGACY_LANES=1 — what each skips. */
export const LEGACY_MIXED: Readonly<Record<string, string>> = {
  // ── tests/harness ──────────────────────────────────────────────────────
  "tests/harness/console-io.test.ts": "the c lane; the wasm-native lane runs",
  "tests/harness/dgram.test.ts": "the c lane; the wasm-native lane runs",
  "tests/harness/event-loop.test.ts": "the c lane; the wasm-native lane runs",
  "tests/harness/tz-matrix.test.ts": "the c and llvm binaries; the wasm lane runs",
  "tests/harness/island-inspect.test.ts": "the c and llvm islands; the wasm lane runs (nothing under SCRIPTC_SAN=1)",
  "tests/harness/web-globals.test.ts": "the default-lane (native) island; the wasm lane runs (nothing under SCRIPTC_SAN=1)",
  "tests/harness/deadstrip.test.ts": "the emitted-C grep; the same dead-strip check runs on the IR, and the reached-construct refusals run",
  "tests/harness/regex.test.ts": "the c-lane abort, size and memory pins; the too-many-captures refusal runs on wasm",
  "tests/harness/errors.test.ts": "nothing: every row builds wasm-native instead of --backend c (S117's trap line set aside)",
  "tests/harness/dyncheck.test.ts": "10 c-only rows (native-handle fence texts, c-island fences, a dynCheck the wasm tier refuses); the other 38 build wasm-native",
  "tests/harness/project-config.test.ts": "the procStream row (refused by the wasm tier); the other compile-and-run rows build wasm-native, not the flagless default",
  "tests/harness/npm-static.test.ts": "nothing: the pilots build wasm-native instead of --backend c / the flagless default",
  "tests/harness/provenance.test.ts": "the island builds (the wasm tier embeds no npm package yet); the source-static build runs on wasm-native",
  "tests/harness/surface-manifest.test.ts": "nothing: listed-static probes build --backend wasm, a backend tier refusal (SC3xxx) counting as lowered",
  // ── packages/compiler/test ─────────────────────────────────────────────
  "packages/compiler/test/board85-arity-widen.test.ts": "the llvm/c binaries; the wasm rows run, and the refusal and IR-disposition rows build wasm",
  "packages/compiler/test/board89-identity.test.ts": "the llvm/c binaries (and the ASan leak rows); the wasm rows run",
  "packages/compiler/test/math-ieee754.test.ts": "the c and llvm lanes (and LINK's nm of a c binary); the wasm lane runs",
  "packages/compiler/test/native-regex-lanes.test.ts": "the c and llvm lanes; the wasm lane runs against Node",
  "packages/compiler/test/regex-state-fuzz.test.ts": "the c and llvm lanes; the wasm lane runs against Node",
  "packages/compiler/test/zlib-lanes.test.ts": "the c and llvm lanes; the wasm lane runs against Node",
  "packages/compiler/test/zlib-prefix.test.ts": "the c/llvm executables and the library archive; the header drift check runs",
  "packages/compiler/test/cc-driver.test.ts": "the C-runtime builds (compileC); the resolveCc driver pins run",
  "packages/compiler/test/wasm-emitter.test.ts": "the reference-C cross-checks inside six rows; the wasm assertions run",
  "packages/compiler/test/wasm-any-array-shared.test.ts": "the c-lane halves of its both-lane rows; the wasm halves run",
  "packages/compiler/test/wasm-path-oracle.test.ts": "the C driver column (scr_path.c); Node vs the module runs",
};

/** A lane list with the legacy lanes ("c", "llvm") dropped unless SCRIPTC_LEGACY_LANES=1. */
export function modernLanes<T extends string>(lanes: readonly T[]): T[] {
  return LEGACY_LANES ? [...lanes] : lanes.filter((l) => l !== "c" && l !== "llvm");
}
