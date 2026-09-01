/* INC-24 P1: character-class case closure — design §6.2's own rule,
 * "[X] matches d iff EXISTS x in X with Canonicalize(x) == Canonicalize(d)",
 * which is equivalent to "canonicalize(d) is a member of {Canonicalize(x)
 * : x in X}" — i.e. the range REBUILT from every member's OWN canonical
 * value, not a widened union of X with its case-variants.
 *
 * NOT a port of cr_regexp_canonicalize (libunicode.c:1496): that function
 * exists to serve BOTH conv_type paths — `unicode_case1(&cr_mask,
 * is_unicode ? CASE_F : CASE_U)` picks between simple case FOLDING
 * (CASE_F, unicode-mode /iu — §6.3's REFUSED conv_type 2) and the plain
 * uppercase conversion (CASE_U, non-unicode /i — the ONLY mode this tier
 * supports). Since /iu never reaches this port (§6.3, FENCED per §6.1),
 * only the CASE_U half is ever needed, and that half is EXACTLY what
 * regex-canon.ts's canonicalize() already computes — MEASURED against
 * Node directly (exhaustive BMP + two named spot-checks, its own test
 * file), not merely argued equivalent to libunicode's C table-walk. So
 * this closure is built by iterating each member of the input CharRange
 * through canonicalize() directly and rebuilding the range, rather than
 * porting cr_regexp_canonicalize's mask/table machinery — using the
 * measured-Node-exact primitive is STRONGER evidence than transcribing a
 * C algorithm whose OTHER half (CASE_F) this port doesn't even need. */
import { canonicalize } from "./regex-canon.js";
import type { CharRange } from "./regex-charclass.js";

/** One past the last valid Unicode code point (0x10FFFF). A negated
 * class (e.g. \D, \S, \W, \P{L}, or [^...]) produces a CharRange whose
 * top interval runs to crInvert's own "infinity" sentinel (0xffffffff,
 * regex-charclass.ts's own doc) — no real subject character can ever be
 * that large, so iterating (or even just bounds-checking) all the way to
 * it is both wrong (canonicalize() rejects an out-of-range code point —
 * caught by this file's own tests exercising a negated class under /i)
 * and needlessly slow (billions of iterations for a genuinely infinite-
 * looking interval). The portion of any interval AT OR ABOVE this bound
 * is preserved UNCHANGED (never iterated, never canonicalized) rather
 * than dropped — it is definitionally unaffected by case folding since
 * nothing real ever reaches it. */
const MAX_CODE_POINT_EXCLUSIVE = 0x110000;

/** Iterates every code point across the range's own intervals, up to
 * MAX_CODE_POINT_EXCLUSIVE — a TSC-time (compile-once-per-pattern) cost,
 * not a per-match one, so iterating even a large range (e.g. \p{L}'s
 * hundreds of thousands of code points) one code point at a time is
 * acceptable; this is not runtime-hot code. Collects canonicalized
 * points into a flat array and sorts+merges ONCE (O(n log n)) rather
 * than folding through crUnionInterval incrementally (which would be
 * O(n²): each call rescans the whole growing result), then appends the
 * preserved above-max tail (guaranteed to sort strictly after every
 * canonicalized point: canonicalize() never maps a valid code point to
 * an invalid one, so the two halves never interleave). */
export function caseCloseClass(cr: CharRange): CharRange {
  const points: number[] = [];
  const tail: number[] = [];
  for (let i = 0; i < cr.length; i += 2) {
    const start = cr[i]!;
    const end = cr[i + 1]!;
    const iterEnd = Math.min(end, MAX_CODE_POINT_EXCLUSIVE);
    for (let cp = start; cp < iterEnd; cp++) points.push(canonicalize(cp));
    if (end > MAX_CODE_POINT_EXCLUSIVE) {
      tail.push(Math.max(start, MAX_CODE_POINT_EXCLUSIVE), end);
    }
  }
  points.sort((a, b) => a - b);
  const result: number[] = [];
  let i = 0;
  while (i < points.length) {
    const start = points[i]!;
    let end = start + 1;
    i++;
    while (i < points.length && points[i]! <= end) {
      if (points[i] === end) end++;
      i++;
    }
    result.push(start, end);
  }
  result.push(...tail);
  return result;
}
