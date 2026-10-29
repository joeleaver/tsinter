/* Unit U (Joe's 2026-10-28 ruling, SEMANTICS.md S119): a typed slot holds
 * `undefined` wherever JavaScript produces one. The representation per
 * slot kind, shared by every builder that reads or writes it:
 *
 * - f64: ONE signaling NaN. Arithmetic quiets a signaling NaN (x86 SSE, and
 *   so V8's wasm and wasm2c's C alike), so `undefined + 1` is an ordinary
 *   NaN with no code on the arithmetic path; only the exact 64 bits below
 *   read as undefined. The sign bit is SET so `Math.abs` — a bit operation
 *   that would otherwise hand the pattern back unchanged — cannot.
 * - bool (i32): 2. A condition reads a stored bool through `& 1`.
 * - string and every other ref kind: null (bindings are nullable already).
 * - a union: its undefined arm's interned instance, or — a union with no
 *   undefined arm — the interned base instance whose tag is
 *   UNDEF_UNION_TAG, a tag no arm has (so every tag test answers false).
 */

/** The f64 undefined: sign 1, exponent all ones, quiet bit clear, payload
 * "undef" — a signaling NaN no arithmetic produces. */
export const UNDEF_F64_BITS = BigInt.asIntN(64, 0xfff4_756e_6465_6600n);

/** The bool undefined (false is 0, true is 1). */
export const UNDEF_BOOL = 2;

/** The reserved union tag: undefined in a union with no undefined arm. */
export const UNDEF_UNION_TAG = -1;
