/* INC-24 P1, CP2b: canonicalize (regex-canon.ts), design §6.2's Canonicalize
 * formula. Verified against Node's own /i matching directly, not against
 * the formula restated a second way (that would prove nothing) — for
 * every BMP code point, its own canonical form must case-insensitively
 * match it in Node's regex engine, exhaustively. */
import { describe, expect, test } from "vitest";
import { canonicalize } from "../src/backend/wasm/regex-canon.js";

describe("canonicalize vs Node's own /i matching, exhaustive over the BMP", () => {
  test("every BMP code point's canonical form case-insensitively matches the original in Node", () => {
    let mismatches = 0;
    const firstFew: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: skip, not real chars
      const canon = canonicalize(cp);
      const orig = String.fromCharCode(cp);
      const canonCh = String.fromCodePoint(canon);
      // Build the regex from the CANONICAL form and test against the
      // ORIGINAL — this is exactly the direction /i matching needs
      // (Canonicalize(pattern-char) === Canonicalize(subject-char)).
      let re: RegExp;
      try {
        re = new RegExp(`^${escapeForRegex(canonCh)}$`, "i");
      } catch {
        continue; // an unpaired surrogate or similar unrepresentable literal
      }
      if (!re.test(orig)) {
        mismatches++;
        if (firstFew.length < 5) firstFew.push(`U+${cp.toString(16)} -> canon U+${canon.toString(16)}`);
      }
    }
    expect(mismatches, `first mismatches: ${firstFew.join("; ")}`).toBe(0);
  });

  test("known ASCII case pairs canonicalize to the same value", () => {
    expect(canonicalize(0x61)).toBe(canonicalize(0x41)); // a, A
    expect(canonicalize(0x7a)).toBe(canonicalize(0x5a)); // z, Z
  });

  test("the >=128-with-cu<128 guard: a code point whose uppercase drops below 128 stays unchanged", () => {
    // design §6.2's own example: U+017F LATIN SMALL LETTER LONG S
    // uppercases to 'S' (U+0053, < 128) — but 0x17F >= 128, so the guard
    // says: return ch UNCHANGED (0x17F), not 0x53. This is the exact
    // asymmetry that keeps long-s from canonicalizing the same as 's'.
    expect(canonicalize(0x17f)).toBe(0x17f);
    // ...while plain 's' does canonicalize toward its uppercase.
    expect(canonicalize(0x73)).toBe(0x53);
    // So long-s and 's' do NOT share a canonical value.
    expect(canonicalize(0x17f)).not.toBe(canonicalize(0x73));
    // Cross-check directly against Node: /s/i must NOT match U+017F.
    expect(/^s$/i.test("ſ")).toBe(false);
  });

  test("the length!=1 guard: a code point whose uppercase is multi-character stays unchanged", () => {
    // U+00DF LATIN SMALL LETTER SHARP S (ß) uppercases to "SS" (length 2)
    // in JS's toUpperCase — the guard says: return ch unchanged.
    expect("ß".toUpperCase().length).toBe(2);
    expect(canonicalize(0xdf)).toBe(0xdf);
  });
});

function escapeForRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
