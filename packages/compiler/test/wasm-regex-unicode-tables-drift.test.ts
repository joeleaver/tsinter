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
import { GC_NAME_ROWS, GC_TABLE, PROP_ROWS } from "../src/backend/wasm/regex-unicode-tables.js";

describe("regex-unicode-tables.ts drift check", () => {
  test("both tables match a fresh re-parse of the live vendored header", () => {
    const headerText = readFileSync("packages/runtime/vendor/quickjs-ng/libunicode-table.h", "utf8");
    const fresh = extractAll(headerText) as { gcTable: number[]; gcNameRows: string[]; propRows: unknown[] };
    expect(fresh.gcTable).toEqual([...GC_TABLE]);
    expect(fresh.gcNameRows).toEqual([...GC_NAME_ROWS]);
    expect(fresh.propRows).toEqual(PROP_ROWS.map((r) => ({ kind: r.kind, aliases: r.aliases, ranges: [...r.ranges] })));
  });

  // The vendored tables' Unicode version against the running Node's: every
  // ported property's ranges must be exactly the code points Node's own
  // \p{…} matches, over all of 0..0x10FFFF, under every alias (measured
  // with Node v24.18.1, process.versions.unicode 17.0). A Node or vendor
  // bump that moves either side trips this row.
  test("every PROP_ROWS row is exactly Node's own \\p{…} under each alias", () => {
    expect(PROP_ROWS.map((r) => r.aliases.split(",")[0])).toEqual(["Han", "Hiragana", "Katakana", "Hangul", "Tangut", "Emoji", "Emoji_Modifier_Base", "Emoji_Modifier", "Emoji_Presentation"]);
    for (const row of PROP_ROWS) {
      for (const alias of row.aliases.split(",")) {
        const re = new RegExp(`^\\p{${row.kind === "sc" ? `Script=${alias}` : alias}}$`, "u");
        const node: number[] = [];
        let start = -1;
        for (let cp = 0; cp <= 0x110000; cp++) {
          const hit = cp < 0x110000 && re.test(String.fromCodePoint(cp));
          if (hit && start < 0) start = cp;
          else if (!hit && start >= 0) {
            node.push(start, cp);
            start = -1;
          }
        }
        expect(node, `${row.kind}=${alias}`).toEqual([...row.ranges]);
      }
    }
  }, 120000);

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
