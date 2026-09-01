/* Drift check for regex-unicode-tables.ts (GENERATED from the vendored
 * quickjs-ng libunicode-table.h by scripts/gen-wasm-regex-unicode-tables.mjs),
 * mirroring wasm-casing-tables-drift.test.ts exactly. Re-parses the LIVE
 * vendored header via the generator's own `extractAll` and asserts both
 * arrays are byte-for-byte identical to what's checked into
 * regex-unicode-tables.ts — a future vendor bump that isn't followed by
 * regeneration trips this instead of silently desynchronizing the two. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations.
import { extractAll } from "../../../scripts/gen-wasm-regex-unicode-tables.mjs";
import { GC_NAME_ROWS, GC_TABLE } from "../src/backend/wasm/regex-unicode-tables.js";

describe("regex-unicode-tables.ts drift check", () => {
  test("both tables match a fresh re-parse of the live vendored header", () => {
    const headerText = readFileSync("packages/runtime/vendor/quickjs-ng/libunicode-table.h", "utf8");
    const fresh = extractAll(headerText) as { gcTable: number[]; gcNameRows: string[] };
    expect(fresh.gcTable).toEqual([...GC_TABLE]);
    expect(fresh.gcNameRows).toEqual([...GC_NAME_ROWS]);
  });

  // Independent of extractAll entirely (same discipline as the casing
  // drift test's third pin): a plain awk extraction of unicode_gc_table's
  // byte list from the live header, done once by hand while building this
  // file, not through this repo's TS parsing at all. If extractAll and
  // this test shared a parsing bug, the test above would still pass
  // silently — this one wouldn't.
  test("first/last GC_TABLE bytes and GC_NAME_ROWS[0]/[end] match an independent awk extraction", () => {
    expect(GC_TABLE[0]).toBe(0xfa);
    expect(GC_TABLE[1]).toBe(0x18);
    expect(GC_TABLE[2]).toBe(0x17);
    expect(GC_TABLE[GC_TABLE.length - 3]).toBe(0xbf);
    expect(GC_TABLE[GC_TABLE.length - 2]).toBe(0x76);
    expect(GC_TABLE[GC_TABLE.length - 1]).toBe(0x20);
    expect(GC_TABLE.length).toBe(4122);
    expect(GC_NAME_ROWS[0]).toBe("Cn,Unassigned");
    expect(GC_NAME_ROWS[GC_NAME_ROWS.length - 1]).toBe("C,Other");
    expect(GC_NAME_ROWS.length).toBe(38);
  });
});
