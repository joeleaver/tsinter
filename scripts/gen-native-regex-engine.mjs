// Regenerates packages/runtime/src/scr_regex_engine.h -- the native lanes'
// regex engine -- by translating the WasmGC tier's regex engine module (the
// ONE regex compiler, the matcher, the regex value) to C. Run from the repo
// root after `pnpm -r build`:
//   node scripts/gen-native-regex-engine.mjs
// The output is checked in (the runtime package compiles it with no
// compiler-package step in between); the drift test
// (packages/compiler/test/native-regex-engine-drift.test.ts) renders it
// afresh and requires the checked-in file byte for byte.
import { writeFileSync } from "node:fs";
import { NATIVE_REGEX_ENGINE_PATH, renderNativeRegexEngine } from "../packages/compiler/dist/backend/regex-native.js";

writeFileSync(NATIVE_REGEX_ENGINE_PATH, renderNativeRegexEngine());
console.log(`wrote ${NATIVE_REGEX_ENGINE_PATH}`);
