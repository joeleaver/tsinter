/* INC-24 P1: Canonicalize (design §6.2's own derivation of ECMA-262's
 * regex Canonicalize abstract operation), NON-UNICODE-CASEFOLD only.
 * Runs at TSC time (design §6.2: "the compile-time class closure, which
 * runs in TypeScript where String.prototype.toUpperCase is the same ECMA
 * Default Case Conversion the tables implement") — so this is NOT a port
 * of lre_canonicalize's C table-walk (libunicode.c:228); it is the
 * design's own formula, expressed directly in terms of JS's built-in
 * toUpperCase, MEASURED against Node directly rather than argued
 * equivalent to the C algorithm (§6.2: 65,960 exhaustive BMP pairs +
 * 187,638 sampled pairs, 0 mismatches). Using Node's own toUpperCase is
 * therefore STRONGER evidence of Node-exactness than transcribing
 * lre_canonicalize would be, not a shortcut around it.
 *
 * *** LOAD-BEARING SCOPE GUARD (§6.3(a), verbatim) *** This function is
 * for non-unicode /i ONLY. Unicode-mode /i (simple case FOLDING,
 * conv_type 2) is a DIFFERENT algorithm this port does not implement —
 * /iu is refused (§6.3, FENCED per §6.1, same class as /v and Annex B).
 * Any caller reaching here for a fold request is a bug: canonicalize()
 * itself has no way to distinguish "asked to fold" from "asked to
 * canonicalize" (it only ever does the latter), so the guard belongs at
 * the CALLER that decides whether ignore_case+unicode should even reach
 * character compilation — not inside this function. */
export function canonicalize(cp: number): number {
  const u = String.fromCodePoint(cp).toUpperCase();
  const chars = [...u];
  if (chars.length !== 1) return cp;
  const cu = chars[0]!.codePointAt(0)!;
  if (cp >= 128 && cu < 128) return cp;
  return cu;
}
