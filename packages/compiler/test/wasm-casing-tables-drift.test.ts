/* Drift check for casing-tables.ts (GENERATED from the vendored
 * quickjs-ng libunicode-table.h by scripts/gen-wasm-casing-tables.mjs).
 * Re-parses the LIVE vendored header via the generator's own `extractAll`
 * (not a duplicated regex — importing the same function the generator
 * itself uses means this test and the generator can't independently
 * drift from EACH OTHER, only from the checked-in output) and asserts
 * every one of the seven arrays is byte-for-byte identical to what's
 * checked into casing-tables.ts. A future vendor bump (or a hand-edit of
 * the generated file) that isn't followed by regeneration trips this
 * instead of silently desynchronizing the two — team-lead's audit note,
 * increment 20 stage A.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations; the values
// extractAll returns are all `number[]`, checked structurally below.
import { extractAll } from "../../../scripts/gen-wasm-casing-tables.mjs";
import {
  CASE_CONV_EXT,
  CASE_CONV_TABLE1,
  CASE_CONV_TABLE2,
  UNICODE_PROP_CASED1_INDEX,
  UNICODE_PROP_CASED1_TABLE,
  UNICODE_PROP_CASE_IGNORABLE_INDEX,
  UNICODE_PROP_CASE_IGNORABLE_TABLE,
} from "../src/backend/wasm/casing-tables.js";

describe("casing-tables.ts drift check", () => {
  test("every table matches a fresh re-parse of the live vendored header", () => {
    const headerText = readFileSync(
      "packages/runtime/vendor/quickjs-ng/libunicode-table.h",
      "utf8",
    );
    const fresh = extractAll(headerText) as {
      table1: number[];
      table2: number[];
      ext: number[];
      casedTable: number[];
      casedIndex: number[];
      ciTable: number[];
      ciIndex: number[];
    };
    expect(fresh.table1).toEqual([...CASE_CONV_TABLE1]);
    expect(fresh.table2).toEqual([...CASE_CONV_TABLE2]);
    expect(fresh.ext).toEqual([...CASE_CONV_EXT]);
    expect(fresh.casedTable).toEqual([...UNICODE_PROP_CASED1_TABLE]);
    expect(fresh.casedIndex).toEqual([...UNICODE_PROP_CASED1_INDEX]);
    expect(fresh.ciTable).toEqual([...UNICODE_PROP_CASE_IGNORABLE_TABLE]);
    expect(fresh.ciIndex).toEqual([...UNICODE_PROP_CASE_IGNORABLE_INDEX]);
  });

  test("top-bit-set entries parse as positive magnitudes, not sign-flipped", () => {
    // case_conv_table1's last two entries have the top bit set
    // (0xb75d9901, 0xf4802231, 0xf4912201 among them) — a generator that
    // mishandled these via a 32-bit bitwise op (`|0`, `<<`) would produce
    // a negative JS number here instead of the true unsigned magnitude.
    const last = CASE_CONV_TABLE1[CASE_CONV_TABLE1.length - 1]!;
    expect(last).toBe(0xf4912201);
    expect(last).toBeGreaterThan(0);
    expect(Number.isInteger(last)).toBe(true);
  });

  // N3-lite (gate finding): the test above proves "not drifted from
  // extractAll", not "extractAll parsed the header correctly" — a bug
  // shared by the generator and this test's import of it would pass
  // silently either way. These seven pairs are hard-coded LITERAL values,
  // independent of extractAll entirely. Source: rev-inc20's own C dump of
  // the FROZEN vendored header — inc20/frozen-ref/dumptables.c compiled
  // and run against inc20/frozen-ref/libunicode-table.h, output at
  // inc20/frozen-ref/tables-ref.txt (a C compiler's own view of the data,
  // not this repo's TS parsing at all). Verified against that dump before
  // writing these in, not copied from casing-tables.ts.
  //
  // This closes "parsed correctly" at spot resolution, in-repo. It is
  // still not exhaustive — the fully independent leg for EVERY value
  // (not just first/last) is the behavioral sweeps in wasm-casing.test.ts
  // (pins #1 and #2), which compare every table-driven case-conversion
  // and predicate result against a live Node oracle across all 1,114,112
  // code points; a table transcription error anywhere would show up there
  // as a wrong mapping or predicate, not just here as a wrong literal.
  test("first/last element of every table matches an independent C dump (not extractAll)", () => {
    expect(CASE_CONV_TABLE1[0]).toBe(0x209a30);
    expect(CASE_CONV_TABLE1[CASE_CONV_TABLE1.length - 1]).toBe(0xf4912201);
    expect(CASE_CONV_TABLE2[0]).toBe(0x1);
    expect(CASE_CONV_TABLE2[CASE_CONV_TABLE2.length - 1]).toBe(0x78);
    expect(CASE_CONV_EXT[0]).toBe(0x399);
    expect(CASE_CONV_EXT[CASE_CONV_EXT.length - 1]).toBe(0xe5);
    expect(UNICODE_PROP_CASED1_TABLE[0]).toBe(0x40);
    expect(UNICODE_PROP_CASED1_TABLE[UNICODE_PROP_CASED1_TABLE.length - 1]).toBe(0x99);
    expect(UNICODE_PROP_CASED1_INDEX[0]).toBe(0xb9);
    expect(UNICODE_PROP_CASED1_INDEX[UNICODE_PROP_CASED1_INDEX.length - 1]).toBe(0x1);
    expect(UNICODE_PROP_CASE_IGNORABLE_TABLE[0]).toBe(0xa6);
    expect(UNICODE_PROP_CASE_IGNORABLE_TABLE[UNICODE_PROP_CASE_IGNORABLE_TABLE.length - 1]).toBe(0xef);
    expect(UNICODE_PROP_CASE_IGNORABLE_INDEX[0]).toBe(0xbe);
    expect(UNICODE_PROP_CASE_IGNORABLE_INDEX[UNICODE_PROP_CASE_IGNORABLE_INDEX.length - 1]).toBe(0xe);
  });
});
