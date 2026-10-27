/* One regex engine for every lane (follow-up unit D; SEMANTICS.md S065,
 * S102): packages/runtime/src/scr_regex_engine.h — the native lanes'
 * regex compiler and matcher — must be exactly the translation of the wasm
 * regex engine module the WasmGC tier and its build time run
 * (backend/regex-native.ts renders it; scripts/gen-native-regex-engine.mjs
 * writes it). An edit to the wasm builders without regenerating, or a hand
 * edit to the header, fails here. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NATIVE_REGEX_ENGINE_PATH, renderNativeRegexEngine } from "../src/backend/regex-native.js";

const root = join(import.meta.dirname, "..", "..", "..");

describe("the native regex engine is generated from the wasm one", () => {
  test("scr_regex_engine.h is a fresh rendering, byte for byte (regenerate: node scripts/gen-native-regex-engine.mjs)", () => {
    const checkedIn = readFileSync(join(root, NATIVE_REGEX_ENGINE_PATH), "utf8");
    expect(checkedIn === renderNativeRegexEngine()).toBe(true);
  });
});
