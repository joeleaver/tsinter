/* INC-24 P1, CP2a: regex-charclass.ts — the CharRange algebra, \d\s\w, and
 * \p{General_Category=...} resolution, transcribed from libunicode.c. Node
 * is the oracle throughout (CLAUDE.md's absolute rule): every table-driven
 * result here is checked against Node's own regex engine directly, not
 * against the design's prose or hand-computed expectations. */
import { describe, expect, test } from "vitest";
import {
  classRangeDSW,
  crInvert,
  crOp,
  crUnionInterval,
  type CharRange,
  unicodeGeneralCategory,
} from "../src/backend/wasm/regex-charclass.js";

/** Point-in-range test over a CharRange's boundary-pair list — binary
 * search since every CharRange here is sorted (crCompress's own
 * invariant). Test-local: the wasm runtime's REOP_range does its own
 * (bytecode-level) range test; this is purely for checking this TS
 * module's OUTPUT against Node, not a port of runtime logic. */
function crContains(cr: CharRange, cp: number): boolean {
  let lo = 0;
  let hi = cr.length; // hi is always even; each pair is [cr[i], cr[i+1])
  while (lo < hi) {
    const midPair = (((lo + hi) >> 1) >> 1) << 1; // round down to an even index
    const s = cr[midPair]!;
    const e = cr[midPair + 1]!;
    if (cp < s) hi = midPair;
    else if (cp >= e) lo = midPair + 2;
    else return true;
  }
  return false;
}

describe("crOp: the four-way boolean set algebra", () => {
  test("union of two disjoint ranges", () => {
    expect(crOp([0, 5], [10, 15], "union")).toEqual([0, 5, 10, 15]);
  });
  test("union of overlapping ranges merges", () => {
    expect(crOp([0, 10], [5, 15], "union")).toEqual([0, 15]);
  });
  test("union of touching ranges merges (crCompress's join)", () => {
    expect(crOp([0, 5], [5, 10], "union")).toEqual([0, 10]);
  });
  test("intersection", () => {
    expect(crOp([0, 10], [5, 15], "inter")).toEqual([5, 10]);
    expect(crOp([0, 5], [10, 15], "inter")).toEqual([]);
  });
  test("xor", () => {
    expect(crOp([0, 10], [5, 15], "xor")).toEqual([0, 5, 10, 15]);
  });
  test("sub (a minus b)", () => {
    expect(crOp([0, 10], [3, 7], "sub")).toEqual([0, 3, 7, 10]);
    expect(crOp([0, 10], [0, 10], "sub")).toEqual([]);
  });
});

describe("crInvert", () => {
  test("inverts a single interval within the full range", () => {
    expect(crInvert([5, 10])).toEqual([0, 5, 10, 0xffffffff]);
  });
  test("double invert is identity (after compress)", () => {
    const cr: CharRange = [5, 10, 20, 30];
    expect(crInvert(crInvert(cr))).toEqual(cr);
  });
  test("inverting the empty range gives everything", () => {
    expect(crInvert([])).toEqual([0, 0xffffffff]);
  });
});

describe("crUnionInterval", () => {
  test("inclusive c2 semantics (unlike crAddInterval's exclusive convention)", () => {
    // [3,3] inclusive == the single code point 3 == half-open [3,4).
    expect(crUnionInterval([], 3, 3)).toEqual([3, 4]);
  });
  test("merges into an existing set", () => {
    expect(crUnionInterval([0, 5], 3, 7)).toEqual([0, 8]);
  });
});

describe("classRangeDSW: \\d \\s \\w against Node directly (exhaustive BMP)", () => {
  test.each([
    ["d", /\d/],
    ["s", /\s/],
    ["w", /\w/],
  ] as const)("class \\%s matches Node's regex for every BMP code point", (cls, nodeRe) => {
    const cr = classRangeDSW(cls);
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      const expected = nodeRe.test(ch);
      const actual = crContains(cr, cp);
      if (actual !== expected) {
        expect.fail(`\\${cls} at U+${cp.toString(16).padStart(4, "0")}: expected ${expected}, got ${actual}`);
      }
    }
  });

  test.each([
    ["D", /\D/],
    ["S", /\S/],
    ["W", /\W/],
  ] as const)("negated class \\%s matches Node's regex for every BMP code point", (cls, nodeRe) => {
    const cr = classRangeDSW(cls);
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      const expected = nodeRe.test(ch);
      const actual = crContains(cr, cp);
      if (actual !== expected) {
        expect.fail(`\\${cls} at U+${cp.toString(16).padStart(4, "0")}: expected ${expected}, got ${actual}`);
      }
    }
  });
});

describe("unicodeGeneralCategory: \\p{L} against Node directly (full code point space)", () => {
  test("General_Category=L matches Node's /\\p{L}/u for EVERY defined code point, 0x0..0x10FFFF, surrogates excluded", () => {
    const cr = unicodeGeneralCategory("L");
    expect(cr).not.toBeNull();
    const nodeRe = /\p{L}/u;
    let mismatches = 0;
    const firstFew: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates aren't code points
      const ch = String.fromCodePoint(cp);
      const expected = nodeRe.test(ch);
      const actual = crContains(cr!, cp);
      if (actual !== expected) {
        mismatches++;
        if (firstFew.length < 5) firstFew.push(`U+${cp.toString(16)}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches, `first mismatches: ${firstFew.join("; ")}`).toBe(0);
  }, 60_000);

  test("the ONLY \\p{...} property the corpus ever uses (extract-patterns.mjs) resolves", () => {
    expect(unicodeGeneralCategory("L")).not.toBeNull();
  });

  test("long-name and extra aliases resolve to the SAME range as the short code", () => {
    expect(unicodeGeneralCategory("Letter")).toEqual(unicodeGeneralCategory("L"));
    expect(unicodeGeneralCategory("Decimal_Number")).toEqual(unicodeGeneralCategory("Nd"));
    expect(unicodeGeneralCategory("digit")).toEqual(unicodeGeneralCategory("Nd"));
    expect(unicodeGeneralCategory("cntrl")).toEqual(unicodeGeneralCategory("Cc"));
    expect(unicodeGeneralCategory("punct")).toEqual(unicodeGeneralCategory("P"));
  });

  test("an atomic (single-bit) category matches Node directly: Nd", () => {
    const cr = unicodeGeneralCategory("Nd");
    expect(cr).not.toBeNull();
    const nodeRe = /\p{Nd}/u;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      expect(crContains(cr!, cp), `U+${cp.toString(16)}`).toBe(nodeRe.test(String.fromCodePoint(cp)));
    }
  });

  test("out-of-scope property names (Script/binary) return null, not a wrong range", () => {
    // Alphabetic is a REAL, Node-valid binary property this port does not
    // resolve — null here must never be silently treated as "invalid to
    // Node" (it isn't) or as an empty match set (also wrong).
    expect(unicodeGeneralCategory("Alphabetic")).toBeNull();
    expect(unicodeGeneralCategory("Nope")).toBeNull();
  });
});
