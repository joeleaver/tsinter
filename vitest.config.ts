import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Compiled-binary + oracle caches for the test lanes (see cc.ts's cache block
// and tests/harness/README.md). Workers inherit SCRIPTC_CACHE_DIR from here;
// SCRIPTC_NO_CACHE=1 in the caller's environment bypasses every cache in both
// directions (no reads, no writes). Production CLI builds never see this —
// caching is opt-in via the env var, and only vitest sets it.
const cacheDir =
  process.env["SCRIPTC_CACHE_DIR"] ??
  fileURLToPath(new URL("./node_modules/.cache/scriptc-tests/cas", import.meta.url));

// Contention control for concurrent agents: SCRIPTC_TEST_WORKERS caps the vitest
// worker pool (the default — all cores — is unchanged when unset). Full-suite
// runs additionally queue behind an advisory lock; see suite-lock.mjs.
const workers = process.env["SCRIPTC_TEST_WORKERS"];

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against compiler source directly — no build step needed.
      "@tsinter/compiler": fileURLToPath(
        new URL("./packages/compiler/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "tests/harness/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
    ],
    // Differential tests spawn clang + binaries; give them room. 300s is a
    // hang detector, not a performance bound: under a merge gate sharing
    // the box with lane compiles, a legitimately compile-heavy corpus
    // entry can starve past 120s (1751 timed out twice on 2026-07-20 while
    // passing in 3s isolated and uncached).
    testTimeout: 300_000,
    hookTimeout: 300_000,
    env: { SCRIPTC_CACHE_DIR: cacheDir },
    ...(workers !== undefined && workers !== ""
      ? { maxWorkers: Number(workers), minWorkers: 1 }
      : {}),
    globalSetup: ["./tests/harness/suite-lock.mjs"],
  },
});
