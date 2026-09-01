/* INC-24 P1: caseCloseClass (regex-class-closure.ts), verified against
 * Node's real /i CLASS matching directly — design §6.2's own governing
 * claim ("[X] matches d iff EXISTS x in X with Canonicalize(x) ==
 * Canonicalize(d)") is what this test checks, not a restatement of the
 * implementation. */
import { describe, expect, test } from "vitest";
import { canonicalize } from "../src/backend/wasm/regex-canon.js";
import { caseCloseClass } from "../src/backend/wasm/regex-class-closure.js";

function crContainsRaw(cr: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = cr.length;
  while (lo < hi) {
    const midPair = (((lo + hi) >> 1) >> 1) << 1;
    const s = cr[midPair]!;
    const e = cr[midPair + 1]!;
    if (cp < s) hi = midPair;
    else if (cp >= e) lo = midPair + 2;
    else return true;
  }
  return false;
}

/** Simulates REOP_range_i's ACTUAL runtime mechanism (libregexp.c:1252):
 * a case-closed range stores the CANONICAL IMAGE of the original members
 * (not their union with the original) — the interpreter canonicalizes
 * the SUBJECT character before testing membership, every time. A test
 * helper that skipped this step would be testing raw REOP_range
 * semantics, not REOP_range_i's — a naive `crContains(closed, cp)` call
 * caught exactly this mismatch (this file's own build history: the first
 * draft used crContainsRaw directly and failed on 'a' and 'z', which
 * looked like an implementation bug until re-deriving from re_emit_range
 * showed the STORED range is the canonical image, not a union — the
 * fix was the TEST, not caseCloseClass). */
function crContains(cr: readonly number[], cp: number): boolean {
  return crContainsRaw(cr, canonicalize(cp));
}

describe("caseCloseClass vs Node's real /i class matching", () => {
  test("[a-z] case-closed matches Node's /[a-z]/i over the full BMP", () => {
    const closed = caseCloseClass([0x61, 0x7b]); // a-z
    const nodeRe = /[a-z]/i;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const expected = nodeRe.test(String.fromCharCode(cp));
      const actual = crContains(closed, cp);
      if (actual !== expected) {
        expect.fail(`U+${cp.toString(16)}: expected ${expected}, got ${actual}`);
      }
    }
  });

  test("[a-z] closes to include A-Z (both directions of the case pair)", () => {
    const closed = caseCloseClass([0x61, 0x7b]);
    expect(crContains(closed, 0x41)).toBe(true); // 'A'
    expect(crContains(closed, 0x7a)).toBe(true); // 'z' (still there)
  });

  test("a single non-letter code point is unaffected (self-canonical)", () => {
    const closed = caseCloseClass([0x31, 0x32]); // just '1'
    expect(closed).toEqual([0x31, 0x32]);
  });

  test("a NEGATED class (crInvert's 0xffffffff sentinel tail) closes without throwing or hanging", () => {
    // \D-shaped: everything except digits — crInvert produces
    // [0, 0x30, 0x3a, 0xffffffff]. Must not try to canonicalize up to
    // the sentinel (would throw on an invalid code point, or take
    // billions of iterations if it somehow didn't).
    const negatedDigits: readonly number[] = [0, 0x30, 0x3a, 0xffffffff];
    let closed: readonly number[] = [];
    expect(() => {
      closed = caseCloseClass(negatedDigits);
    }).not.toThrow();
    // The above-Unicode-range tail must be preserved as-is (untouched —
    // nothing real can canonicalize into or out of it).
    expect(closed[closed.length - 1]).toBe(0xffffffff);
    // Cross-check against Node's actual /[^0-9]/i behavior over a sample.
    const nodeRe = /[^0-9]/i;
    for (const cp of [0x30, 0x39, 0x41, 0x61, 0xff, 0xffff]) {
      expect(crContains(closed, cp), `U+${cp.toString(16)}`).toBe(nodeRe.test(String.fromCharCode(cp)));
    }
  });

  test("§6.2's own asymmetric example: long-s U+017F does NOT get pulled in by closing [s]", () => {
    // canonicalize(0x17F) = 0x17F (unchanged, per the >=128-with-cu<128
    // guard) while canonicalize('s') = 'S' (0x53) — different canonical
    // values, so [s] case-closed must NOT include long-s.
    const closed = caseCloseClass([0x73, 0x74]); // just 's'
    expect(crContains(closed, 0x17f)).toBe(false);
    // Cross-check directly against Node.
    expect(/[s]/i.test("ſ")).toBe(false);
  });

  test("a multi-range class closes correctly against Node, sampled over a mixed set", () => {
    // [a-fA-F0-9] (hex digit class) case-closed should be self-stable
    // (already contains both cases) — sampled BMP check.
    const closed = caseCloseClass([0x30, 0x3a, 0x41, 0x47, 0x61, 0x67]);
    const nodeRe = /[a-fA-F0-9]/i;
    for (let cp = 0; cp <= 0xffff; cp++) {
      expect(crContains(closed, cp), `U+${cp.toString(16)}`).toBe(nodeRe.test(String.fromCharCode(cp)));
    }
  });
});
