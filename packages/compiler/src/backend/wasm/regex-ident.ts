/* INC-24 P1, CP2c: lre_js_is_ident_first / lre_js_is_ident_next
 * (libregexp.h:78-95) — named-group-name character validity.
 *
 * NOT a port of libregexp's own ID_Start/ID_Continue TABLES
 * (unicode_prop_ID_Start_table etc., libunicode.c:536-549): this runs at
 * TSC time in the SAME Node process whose regex engine already implements
 * `\p{ID_Start}`/`\p{ID_Continue}` as standard Unicode property escapes —
 * and since validating a group NAME is fundamentally "would Node accept
 * this as `(?<name>...)`'s name", asking Node's own regex engine directly
 * is a more direct oracle than transcribing a table meant to approximate
 * it. Verified live (not assumed): `$`/`_` are NOT part of Unicode's raw
 * ID_Start/ID_Continue (Node confirms `/\p{ID_Start}/u.test("$")` is
 * false) — they are ECMA-262's own IdentifierStart/IdentifierPart
 * additions, matching libregexp's explicit fast-path table for them;
 * ZWNJ/ZWJ (U+200C/U+200D) ARE already included in Node's ID_Continue
 * (verified live), so the reference's explicit `|| c==0x200C ||
 * c==0x200D` is redundant against Node's data but included below anyway
 * for exact structural fidelity to the reference's own conditions. */
const ID_START_RE = /\p{ID_Start}/u;
const ID_CONTINUE_RE = /\p{ID_Continue}/u;

export function isIdentFirst(cp: number): boolean {
  if (cp === 0x24 /* '$' */ || cp === 0x5f /* '_' */) return true;
  return ID_START_RE.test(String.fromCodePoint(cp));
}

export function isIdentNext(cp: number): boolean {
  if (cp === 0x24 || cp === 0x5f || cp === 0x200c || cp === 0x200d) return true;
  return ID_CONTINUE_RE.test(String.fromCodePoint(cp));
}
