/* One ieee754.cc for every lane (SEMANTICS.md S100): the native lanes compile
 * the vendored V8 file (packages/runtime/vendor/v8-ieee754/src/base/ieee754.cc,
 * through packages/runtime/src/scr_ieee754.cc), and the WasmGC tier compiles
 * backend/wasm/ieee754-src.ts, which scripts/gen-wasm-ieee754-src.mjs renders
 * from that same file. This pins the two together: the vendored file is the
 * pinned V8 13.6.233.17 text (sha256), and the checked-in TypeScript is
 * exactly the generator's rendering of it -- an edit to either side without the
 * other fails here. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error -- a plain .mjs script with no declaration file
import { OUT_PATH, renderIeee754Src, VENDORED_PATH, VENDORED_SHA256 } from "../../../scripts/gen-wasm-ieee754-src.mjs";
import { IEEE754_CC } from "../src/backend/wasm/ieee754-src.js";

const root = join(import.meta.dirname, "..", "..", "..");
const vendored = readFileSync(join(root, VENDORED_PATH as string), "utf8");

describe("ieee754.cc exists once", () => {
  test("the vendored file is V8 13.6.233.17's src/base/ieee754.cc", () => {
    expect(createHash("sha256").update(vendored).digest("hex")).toBe(VENDORED_SHA256);
    expect(VENDORED_SHA256).toBe("1bf999809d4c4c1d31ad5ff3578d32614796f159e08b9e7782560d017721a0c2");
  });

  test("ieee754-src.ts is the generator's rendering of the vendored file, byte for byte", () => {
    const checkedIn = readFileSync(join(root, OUT_PATH as string), "utf8");
    expect(checkedIn).toBe((renderIeee754Src as (cc: string) => string)(vendored));
  });

  test("the wasm text is the vendored text with only the legacy namespace removed", () => {
    const legacyStart = vendored.indexOf("namespace legacy {");
    const legacyEnd = vendored.indexOf("}  // namespace legacy") + "}  // namespace legacy".length;
    const marker = /\/\* \[tsinter\] upstream lines \d+-\d+ \(namespace legacy: the pre-2019 pow\) omitted \*\//;
    expect(IEEE754_CC.replace(marker, "")).toBe("\n" + vendored.slice(0, legacyStart) + vendored.slice(legacyEnd));
  });

  test("the native wrapper compiles the vendored file itself", () => {
    const wrapper = readFileSync(join(root, "packages/runtime/src/scr_ieee754.cc"), "utf8");
    expect(wrapper).toContain('#include "src/base/ieee754.cc"');
  });
});
