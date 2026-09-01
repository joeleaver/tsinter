/* INC-24 P1: character-class algebra and atom data, transcribed from the
 * vendored quickjs-ng libunicode.c/libregexp.c (1:1 transcription per
 * CLAUDE.md's Node-is-the-oracle rule and this design's own mandate — see
 * design-regex-v6.txt §2.3 ground 3). Runs entirely at TSC TIME (Node
 * process), never inside a compiled wasm module — \p{...} and \d\s\w
 * resolve to concrete code-point ranges here, and only the RESOLVED
 * ranges reach the module's data segment (design §2.3 ground 5, §3.4).
 *
 * SCOPE: the /v flag (unicode sets) is refused at the frontend (SC1120,
 * design §5.1's flags table, before any pattern body is read) so every
 * `unicode_sets`-gated branch in the reference is DEAD CODE for this tier
 * and is not ported. REACHABILITY, verified at the source rather than by
 * name (lead's rider): `s->unicode_sets` is assigned EXACTLY ONCE in the
 * whole file, at parser init from the flags string
 * (libregexp.c:2551, `s->unicode_sets = ((re_flags & LRE_FLAG_UNICODE_SETS)
 * != 0)`) — every other occurrence (libregexp.c:978,990,1137,1144,1196,
 * 1211,1418,1428,1486) is a READ, never a reassignment, so it is a pure
 * per-call constant derived solely from the flags string, never from
 * anything pattern-body-dependent. Since our frontend's SC1120 refusal
 * fires on the bare presence of 'v' before any pattern reaches this
 * module, `unicode_sets` can never be true here. This is dead-code
 * elimination, not a behavioral "X is equivalent to Y" simplification:
 * the skipped branches are unreachable by construction, so there is no
 * equivalence claim to probe. EVERY excised branch below carries its own
 * marker at the omission point (libregexp line range + the specific guard
 * + "a /v lift must port it") per the lead's per-branch discipline — this
 * paragraph is the shared reachability evidence those markers cite by
 * reference, not a substitute for citing it at each site.
 *
 * \p{...} SCOPE: General_Category ONLY (unicode_gc_table,
 * regex-unicode-tables.ts) — the ONLY \p{...} property anywhere in the
 * 1077-program corpus is \p{L} (extract-patterns.mjs). Script
 * (\p{Script=...}) and binary (\p{Alphabetic} etc.) properties use
 * DIFFERENT vendored table formats (libunicode.c:1153 unicode_script,
 * :1340 unicode_prop1) and are not ported; unicodeGeneralCategory
 * returns null for a name it can't resolve, INCLUDING valid-to-Node names
 * outside General_Category — callers must not conflate that with Node's
 * own "invalid property name" SyntaxError (§5.5's message table), since
 * the two are different failure classes with different correct
 * behaviors. */
import { caseCloseClass } from "./regex-class-closure.js";
import { parseEscape } from "./regex-escape.js";
import { GC_NAME_ROWS, GC_TABLE } from "./regex-unicode-tables.js";

/** A CharRange is a sorted, disjoint list of boundary points (always even
 * length): [s0, e0, s1, e1, ...] representing the union of the half-open
 * intervals [s0,e0) ∪ [s1,e1) ∪ ... — the exact shape of libunicode.c's
 * `CharRange.points` (this port drops `size`/`mem_opaque`/`realloc_func`:
 * a plain growable JS array already has automatic capacity management,
 * so there is nothing for those fields to do here). */
export type CharRange = readonly number[];

/** cr_add_point / cr_add_interval (libunicode.h:71,81) — RAW append, no
 * merging. Valid only when the caller already guarantees points arrive in
 * increasing, non-overlapping order (e.g. unicodeGeneralCategory1's
 * single left-to-right pass over GC_TABLE) — anywhere the input isn't
 * already ordered, use crUnionInterval/crOp instead. */
export function crAddInterval(cr: number[], c1: number, c2: number): void {
  cr.push(c1, c2);
}

/** cr_compress (libunicode.c:426) — merge touching/overlapping intervals
 * and drop empty ones. cr_op always ends with this; it is what keeps a
 * CharRange in the canonical disjoint-sorted form every other primitive
 * here assumes on input. */
function crCompress(points: readonly number[]): CharRange {
  const out: number[] = [];
  let i = 0;
  const len = points.length;
  while (i + 1 < len) {
    if (points[i] === points[i + 1]) {
      i += 2;
      continue;
    }
    let j = i;
    while (j + 3 < len && points[j + 1] === points[j + 2]) j += 2;
    out.push(points[i]!, points[j + 1]!);
    i = j + 2;
  }
  return out;
}

export type CrOp = "union" | "inter" | "xor" | "sub";

/** cr_op (libunicode.c:455) — the general two-set boolean algebra every
 * other set operation here is built from: a single merge-sort pass over
 * both boundary-point lists, tracking each side's "currently inside an
 * interval" parity (odd count-so-far = inside) and emitting a boundary
 * whenever the combined in/out status flips. The four ops differ only in
 * how the two parities combine (verbatim from the switch at :485). */
export function crOp(aPt: CharRange, bPt: CharRange, op: CrOp): CharRange {
  const out: number[] = [];
  let aIdx = 0;
  let bIdx = 0;
  for (;;) {
    let v: number;
    if (aIdx < aPt.length && bIdx < bPt.length) {
      if (aPt[aIdx]! < bPt[bIdx]!) {
        v = aPt[aIdx++]!;
      } else if (aPt[aIdx] === bPt[bIdx]) {
        v = aPt[aIdx]!;
        aIdx++;
        bIdx++;
      } else {
        v = bPt[bIdx++]!;
      }
    } else if (aIdx < aPt.length) {
      v = aPt[aIdx++]!;
    } else if (bIdx < bPt.length) {
      v = bPt[bIdx++]!;
    } else {
      break;
    }
    const aIn = aIdx & 1;
    const bIn = bIdx & 1;
    let isIn: number;
    switch (op) {
      case "union":
        isIn = aIn | bIn;
        break;
      case "inter":
        isIn = aIn & bIn;
        break;
      case "xor":
        isIn = aIn ^ bIn;
        break;
      case "sub":
        isIn = aIn & (bIn ^ 1);
        break;
    }
    if (isIn !== (out.length & 1)) out.push(v);
  }
  return crCompress(out);
}

/** cr_union_interval (libunicode.h:94) — c2 is INCLUSIVE here (unlike
 * crAddInterval's exclusive c2), matching the reference's own asymmetry:
 * this is the entry point every `[a-z]`-style range in a character class
 * goes through, and ECMAScript ranges are written inclusive. */
export function crUnionInterval(cr: CharRange, c1: number, c2: number): CharRange {
  return crOp(cr, [c1, c2 + 1], "union");
}

/** cr_invert (libunicode.c:522) — prepend a 0 boundary and append a
 * sentinel "infinity" boundary, then compress. 0xffffffff (not
 * 0x10ffff+1) matches the reference exactly: no subject code point can
 * ever reach it, so the sentinel's exact value is unobservable, and
 * porting the reference's own constant is safer than reasoning about
 * whether a tighter bound is equivalent. */
export function crInvert(cr: CharRange): CharRange {
  return crCompress([0, ...cr, 0xffffffff]);
}

/* ---- \d \s \w (libregexp.c:404-433) — tiny hand-transcribed tables, not
 * vendored-header data (they live in libregexp.c itself, human-readable,
 * nowhere near the 4122-byte GC_TABLE's generator-script scale). Each is
 * already a flat list of [start, end) pairs — the SAME convention
 * CharRange.points uses — so these ARE valid CharRanges directly, no
 * conversion step. */
const CHAR_RANGE_D: CharRange = [0x0030, 0x003a];
const CHAR_RANGE_S: CharRange = [
  0x0009, 0x000e, 0x0020, 0x0021, 0x00a0, 0x00a1, 0x1680, 0x1681, 0x2000, 0x200b, 0x2028, 0x202a, 0x202f, 0x2030,
  0x205f, 0x2060, 0x3000, 0x3001, 0xfeff, 0xff00,
];
const CHAR_RANGE_W: CharRange = [0x0030, 0x003a, 0x0041, 0x005b, 0x005f, 0x0060, 0x0061, 0x007b];

export type DsWClass = "d" | "D" | "s" | "S" | "w" | "W";

/** cr_init_char_range (libregexp.c:452) — \d\D\s\S\w\W as CharRanges;
 * the uppercase (negated) forms are cr_invert of the lowercase table,
 * exactly as the reference computes them (`invert = c & 1` over a shared
 * `char_range_table`), not as independently-listed data. */
export function classRangeDSW(cls: DsWClass): CharRange {
  switch (cls) {
    case "d":
      return CHAR_RANGE_D;
    case "D":
      return crInvert(CHAR_RANGE_D);
    case "s":
      return CHAR_RANGE_S;
    case "S":
      return crInvert(CHAR_RANGE_S);
    case "w":
      return CHAR_RANGE_W;
    case "W":
      return crInvert(CHAR_RANGE_W);
  }
}

/* ---- \p{General_Category=...} (libunicode.c:1288 unicode_general_category1,
 * :1683 unicode_general_category) ---- */

/** Row index of each GC short code in GC_NAME_ROWS, DERIVED from the
 * generated table itself (row i's first alias) rather than a hand-typed
 * parallel list — a table reorder can't desync this from GC_NAME_ROWS
 * because there is nothing hand-typed to desync. */
/* unicode_find_name (libunicode.c:1124) — every row is a COMMA-SEPARATED
 * list of aliases (e.g. row 31 is "L,Letter"), and any of them resolves
 * to that row's index; not just the first. GC_IDX maps every alias of
 * every row to its row index, built from GC_NAME_ROWS itself so a table
 * regeneration can't desync it from the data. */
const GC_IDX: Readonly<Record<string, number>> = Object.fromEntries(
  GC_NAME_ROWS.flatMap((row, i) => row.split(",").map((alias) => [alias, i] as const)),
);
const GC_CO_IDX = GC_IDX["Co"]!; // last of the 30 atomic (single-bit) categories
const GC_LC_IDX = GC_IDX["LC"]!; // first of the 8 composite categories

function gcBit(shortName: string): number {
  return 1 << GC_IDX[shortName]!;
}

/** unicode_gc_mask_table (libunicode.c:1670) — the 8 composite categories'
 * bitmasks, computed from the SAME derived indices gcBit reads, matching
 * the reference's own `M(id)` macro composition line for line rather than
 * transcribing 8 pre-computed hex constants (which would be one more
 * place a GC_TABLE/GC_NAME_ROWS regeneration could silently desync from). */
const GC_COMPOSITE_MASK: readonly number[] = [
  gcBit("Lu") | gcBit("Ll") | gcBit("Lt"), // LC
  gcBit("Lu") | gcBit("Ll") | gcBit("Lt") | gcBit("Lm") | gcBit("Lo"), // L
  gcBit("Mn") | gcBit("Mc") | gcBit("Me"), // M
  gcBit("Nd") | gcBit("Nl") | gcBit("No"), // N
  gcBit("Sm") | gcBit("Sc") | gcBit("Sk") | gcBit("So"), // S
  gcBit("Pc") | gcBit("Pd") | gcBit("Ps") | gcBit("Pe") | gcBit("Pi") | gcBit("Pf") | gcBit("Po"), // P
  gcBit("Zs") | gcBit("Zl") | gcBit("Zp"), // Z
  gcBit("Cc") | gcBit("Cf") | gcBit("Cs") | gcBit("Co") | gcBit("Cn"), // C
];

/** unicode_general_category1 (libunicode.c:1288) — the single left-to-
 * right RLE decode over GC_TABLE: each byte's top 3 bits are a short run
 * length (7 = escape to a longer length in following bytes, itself
 * 1/2/3-byte-encoded by magnitude), the low 5 bits select which
 * general-category bit the run belongs to — EXCEPT value 31, a special
 * "this run alternates Lu/Ll every code point" marker (surrogate-adjacent
 * casing pairs are encoded this way to save space). Ports the reference's
 * control flow exactly, including its `goto add_range` shared exit
 * (inlined here as a duplicated crAddInterval call — no `goto` in TS, and
 * duplicating a single call is clearer than simulating one with a flag). */
function unicodeGeneralCategory1(gcMask: number): CharRange {
  const cr: number[] = [];
  let p = 0;
  const pEnd = GC_TABLE.length;
  let c = 0;
  while (p < pEnd) {
    const b = GC_TABLE[p++]!;
    let n = b >> 5;
    const v = b & 0x1f;
    if (n === 7) {
      n = GC_TABLE[p++]!;
      if (n < 128) {
        n += 7;
      } else if (n < 128 + 64) {
        n = (n - 128) << 8;
        n |= GC_TABLE[p++]!;
        n += 7 + 128;
      } else {
        n = (n - 128 - 64) << 16;
        n |= GC_TABLE[p++]! << 8;
        n |= GC_TABLE[p++]!;
        n += 7 + 128 + (1 << 14);
      }
    }
    const c0start = c;
    c += n + 1;
    if (v === 31) {
      const luLl = gcMask & (gcBit("Lu") | gcBit("Ll"));
      if (luLl !== 0) {
        if (luLl === (gcBit("Lu") | gcBit("Ll"))) {
          crAddInterval(cr, c0start, c);
        } else {
          const startsWithLl = (gcMask & gcBit("Ll")) !== 0;
          for (let c0 = c0start + (startsWithLl ? 1 : 0); c0 < c; c0 += 2) {
            crAddInterval(cr, c0, c0 + 1);
          }
        }
      }
    } else if ((gcMask >>> v) & 1) {
      crAddInterval(cr, c0start, c);
    }
  }
  return cr;
}

/** unicode_general_category (libunicode.c:1683) — resolves a
 * General_Category name (any alias in GC_NAME_ROWS: short code, long
 * name, or the handful of extra aliases like "digit"/"cntrl"/"punct") to
 * its CharRange. Returns null when the name isn't a General_Category
 * alias at all — this is NOT the same as Node rejecting the pattern: a
 * null here can mean "valid Script/binary property Node accepts, just
 * outside this port's scope" as well as "genuinely unknown to Node too"
 * (§5.5's "Invalid property name" case) — the caller must keep those
 * distinct, never collapse a null into an assumed-invalid verdict. */
export function unicodeGeneralCategory(name: string): CharRange | null {
  const gcIdx = GC_IDX[name];
  if (gcIdx === undefined) return null;
  const gcMask = gcIdx <= GC_CO_IDX ? 1 << gcIdx : GC_COMPOSITE_MASK[gcIdx - GC_LC_IDX]!;
  return unicodeGeneralCategory1(gcMask);
}

/** Result of parsing `\p{...}` / `\P{...}` — parse_unicode_property
 * (libunicode.c:882-1000). `cr: null` distinguishes "syntactically a
 * `\p{name}` or `\p{name=value}` form, but NAME isn't resolvable" from a
 * malformed `{...}` body (which is a parse error, `error` set instead).
 * Node's own verdict on an unresolvable name is a SyntaxError
 * ("Invalid property name", §5.5) for a name Node ALSO doesn't know — but
 * this port cannot tell "Node doesn't know it either" apart from "Node
 * knows it, it's just outside General_Category" (Script=/binary
 * properties), so `cr: null` must never be reported as that SyntaxError
 * by a caller; it is a scope boundary, not a verdict. */
export interface UnicodePropertyResult {
  cr: CharRange | null;
  next: number;
  error?: string;
}

const isUnicodePropChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;

/** parse_unicode_property (libunicode.c:882). `isInv` is true for `\P`.
 * SCOPE-NARROWED from the reference: only the `name` form (bare
 * `\p{GeneralCategoryAlias}`) and the `General_Category=`/`gc=` explicit
 * form resolve; `Script=`/`Script_Extensions=`/`scx=` (libunicode.c:918-932,
 * unicode_script) and the `allow_sequence_prop` sequence-property path
 * (libunicode.c:957-966, unicode_sequence_prop — itself only reachable
 * when `allow_sequence_prop` is true, and the reference's ONLY caller
 * passes `s->unicode_sets` as that argument, libregexp.c:1137: dead by
 * the same file-header reachability evidence, so this port never even
 * threads an allow_sequence_prop parameter) are NOT ported — see this
 * file's header comment's \p{...} SCOPE paragraph. `cr: null` (not an
 * error) is returned for any name outside General_Category, including
 * Script=/scx=/sequence-property SYNTAX, which callers must treat as an
 * "unsupported, not a Node verdict" outcome.
 *
 * ALSO NARROWED (case-folding ordering, libunicode.c:974-995): the
 * reference applies case-fold-then-invert under `unicode_sets` and
 * invert-then-case-fold otherwise; since unicode_sets is always false
 * here, only the invert-then-fold order is live. NOT YET PORTED: the
 * case-folding step itself (re_string_list_canonicalize) — §6.2's /i
 * class closure is built as a SEPARATE compile-time pass over an
 * assembled class (design §6.2's own framing: "the compile-time class
 * closure, which runs in TypeScript"), not inline here; this function
 * returns the RAW (non-case-folded) category range, matching what a
 * non-/i pattern needs, and the /i closure step (not yet built) will
 * apply Canonicalize over the result the same way it does for \d\s\w. */
export function parseUnicodeProperty(pattern: string, pos: number, isInv: boolean): UnicodePropertyResult {
  let p = pos;
  if (pattern.charCodeAt(p) !== 0x7b /* '{' */) {
    return { cr: null, next: p, error: "expecting '{' after \\p" };
  }
  p++;
  let name = "";
  while (isUnicodePropChar(pattern.charCodeAt(p))) name += pattern[p++];
  let value = "";
  if (pattern.charCodeAt(p) === 0x3d /* '=' */) {
    p++;
    while (isUnicodePropChar(pattern.charCodeAt(p))) value += pattern[p++];
  }
  if (pattern.charCodeAt(p) !== 0x7d /* '}' */) {
    return { cr: null, next: p, error: "expecting '}'" };
  }
  p++;

  let cr: CharRange | null;
  if (value === "" && (name === "Script" || name === "sc" || name === "Script_Extensions" || name === "scx")) {
    // libunicode.c:918-932 (unicode_script) — NOT PORTED, see the scope
    // note above. A /v lift porting Script= support would resolve here.
    cr = null;
  } else if (name === "Script" || name === "sc" || name === "Script_Extensions" || name === "scx") {
    cr = null; // Script=value / scx=value form — same scope note.
  } else if (name === "General_Category" || name === "gc") {
    cr = unicodeGeneralCategory(value);
  } else if (value === "") {
    cr = unicodeGeneralCategory(name);
    // libunicode.c:951-956 (unicode_prop, binary properties like
    // Alphabetic) and :957-966 (unicode_sequence_prop, only reachable
    // when allow_sequence_prop — dead here) are NOT PORTED when
    // unicodeGeneralCategory itself returns null; cr stays null exactly
    // as the scope note above states, not escalated to an error.
  } else {
    cr = null; // an explicit name=value pair outside General_Category.
  }
  if (cr === null) return { cr: null, next: p };
  if (isInv) cr = crInvert(cr);
  return { cr, next: p };
}

/** Result of get_class_atom (libregexp.c:1056). A literal character, or a
 * pre-resolved CharRange (\d\s\w\p{...}) — the reference's CLASS_RANGE_BASE
 * sentinel-through-one-int trick becomes a real discriminated union here.
 * `dsw` (range only): set to the letter ("d"/"D"/"s"/"S"/"w"/"W") for a
 * \d\D\s\S\w\W ESCAPE SPECIFICALLY, never for a \p{...}/\P{...}
 * property (also a "range" result, but NOT dsw-tagged). Two things key
 * off this, both verified empirically against the live oracle (design's
 * own C source doesn't spell this out in one place — the case-closing
 * rule in particular was reverse-engineered from lre_compile's actual
 * output, not read off a single function): (1) the ASSEMBLER's bare-
 * atom emission (libregexp.c:2183-2196) picks REOP_space/REOP_not_space
 * over the general range encoding ONLY for dsw==="s"/"S", never for the
 * other four or for \p{}; (2) case-CLOSING (§6.2) — a \d\D\s\S\w\W
 * MEMBER is used RAW, UNCLOSED, in EVERY context (bare atom AND folded
 * into a `[...]` combination), regardless of ignoreCase — verified via
 * `[\w]/i` keeping BOTH `a-z` and `A-Z` (the raw, un-closed \w range)
 * rather than collapsing to just `A-Z` (what per-member closing would
 * produce); a \p{...} property, and any literal char/explicit range,
 * DOES get closed (image-only, matching a bare literal char) — verified
 * via `[\wé]/i` keeping \w raw while closing 'é' to 'É' in the SAME
 * class. See parseCharClass's per-member closing and
 * parseClassAtomTerm's bare-atom closing — both read this tag now,
 * neither re-applies closing to a dsw member. */
export type ClassAtomResult = { kind: "char"; cp: number; next: number } | { kind: "range"; cr: CharRange; next: number; dsw?: "d" | "D" | "s" | "S" | "w" | "W" };

const isAsciiLower = (c: number): boolean => c >= 0x61 && c <= 0x7a;
const isAsciiUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;
const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** get_class_atom (libregexp.c:1056). `pos` points AT the atom's first
 * character (not past any backslash). Returns null for a malformed
 * escape/unexpected-end (the reference's `re_parse_error` paths) —
 * distinguishing WHICH error is the caller's job once one exists to call
 * this with real diagnostics; this port surfaces "parse failed here",
 * matching how parseEscape already collapses its own error taxonomy. */
export function getClassAtom(pattern: string, pos: number, inclass: boolean, isUnicode: boolean): ClassAtomResult | null {
  let p = pos;
  if (p >= pattern.length) return null; // buf_end guard (libregexp.c:1170's unexpected_end)
  const c0 = pattern.charCodeAt(p);

  if (c0 === 0x5c /* '\\' */) {
    p++;
    if (p >= pattern.length) return null; // unexpected_end
    const esc = pattern.charCodeAt(p);
    p++;
    switch (esc) {
      case 0x64: // 'd'
        return { kind: "range", cr: classRangeDSW("d"), next: p, dsw: "d" };
      case 0x44: // 'D'
        return { kind: "range", cr: classRangeDSW("D"), next: p, dsw: "D" };
      case 0x73: // 's'
        return { kind: "range", cr: classRangeDSW("s"), next: p, dsw: "s" };
      case 0x53: // 'S'
        return { kind: "range", cr: classRangeDSW("S"), next: p, dsw: "S" };
      case 0x77: // 'w'
        return { kind: "range", cr: classRangeDSW("w"), next: p, dsw: "w" };
      case 0x57: // 'W'
        return { kind: "range", cr: classRangeDSW("W"), next: p, dsw: "W" };
      case 0x63: {
        // '\cX' control-letter escape (libregexp.c:1097-1112).
        const cc = pattern.charCodeAt(p);
        if (isAsciiLower(cc) || isAsciiUpper(cc) || ((isAsciiDigit(cc) || cc === 0x5f) && inclass && !isUnicode)) {
          // Annex B.1.4
          return { kind: "char", cp: cc & 0x1f, next: p + 1 };
        } else if (isUnicode) {
          return null; // invalid_escape
        } else {
          // "otherwise return '\' and 'c'": the backslash is literal, 'c'
          // is left for the NEXT atom — cursor lands right after the
          // backslash, at 'c' itself (libregexp.c:1108-1111's `p--`).
          return { kind: "char", cp: 0x5c, next: p - 1 };
        }
      }
      case 0x2d: // '-'
        // libregexp.c:1113-1116: \- outside a class under /u is invalid
        // (Annex-B-only elsewhere, design §5.1's out-of-class row);
        // inside a class, or without /u, it's a literal '-' (§5.1's v6
        // in-class row) — falls through to the literal-char return below.
        if (!inclass && isUnicode) return null; // invalid_escape
        return { kind: "char", cp: 0x2d, next: p };
      case 0x5e: // '^'
      case 0x24: // '$'
      case 0x5c: // '\\'
      case 0x2e: // '.'
      case 0x2a: // '*'
      case 0x2b: // '+'
      case 0x3f: // '?'
      case 0x28: // '('
      case 0x29: // ')'
      case 0x5b: // '['
      case 0x5d: // ']'
      case 0x7b: // '{'
      case 0x7d: // '}'
      case 0x7c: // '|'
      case 0x2f: // '/'
        // "always valid to escape these characters" (libregexp.c:1130-1133).
        return { kind: "char", cp: esc, next: p };
      case 0x70: // 'p'
      case 0x50: {
        // 'P'
        if (isUnicode) {
          const r = parseUnicodeProperty(pattern, p, esc === 0x50);
          if (r.error !== undefined || r.cr === null) return null;
          return { kind: "range", cr: r.cr, next: r.next };
        }
        // NOT unicode: falls through to default_escape below, exactly
        // like the reference's `goto default_escape` — \p becomes the
        // Annex-B identity escape (design §5.1's "\p is literal 'p'"
        // row), handled by the shared default_escape path.
        return defaultEscape(pattern, pos, p, esc, inclass, isUnicode);
      }
      // 'q' (libregexp.c:1143-1150, \q{...} class-string disjunction):
      // gated `s->unicode_sets && cr && inclass` — dead by this file's
      // header reachability evidence. NOT PORTED: a /v lift porting
      // \q{...} support (parse_class_string_disjunction) resolves here.
      // Falls to default_escape exactly as the reference's own
      // `goto default_escape` does when the guard is false (which it
      // always is here) — no special case needed for 'q' at all.
      default:
        return defaultEscape(pattern, pos, p, esc, inclass, isUnicode);
    }
  }

  // libregexp.c:1177-1200 ('&','!','#','$','%','*','+',',','.',':',';',
  // '<','=','>','?','@','^','`','~') and :1202-1215 ('(',')','[',']','{',
  // '}','/','-','|'): both groups' ONLY special handling is a
  // `s->unicode_sets`-gated rejection (the "forbidden double characters"
  // and "invalid character in class" checks) — dead by this file's header
  // reachability evidence, so both groups fall to the SAME normal_char
  // path every other character takes; no separate case is needed here.
  // NOT PORTED: a /v lift porting unicode-sets-mode class-set syntax
  // restrictions resolves at libregexp.c:1196 and :1211.
  return normalChar(pattern, p, isUnicode);
}

/** default_escape (libregexp.c:1151-1166) — the fallback for any escape
 * get_class_atom's own switch doesn't special-case. `outerC` is the
 * character right after the backslash (get_class_atom's own `c` at this
 * point, needed for the non-unicode "ignore the backslash" fallback,
 * which reprocesses that SAME character as a literal via normalChar —
 * traced from the reference's `p--` (undoing lre_parse_escape's internal
 * re-consumption) landing exactly back at `backslashPos + 1`). */
function defaultEscape(
  pattern: string,
  backslashCharPos: number,
  afterEscCharPos: number,
  outerC: number,
  _inclass: boolean,
  isUnicode: boolean,
): ClassAtomResult | null {
  const esc = parseEscape(pattern, backslashCharPos + 1, isUnicode ? 2 : 0);
  if (esc !== null) return { kind: "char", cp: esc.value, next: esc.next };
  if (isUnicode) return null; // invalid_escape
  // "just ignore the '\'": reprocess the escaped character itself as a
  // literal, cursor landing right after IT (not after any further bytes
  // lre_parse_escape may have peeked at and rejected).
  return normalChar(pattern, backslashCharPos + 1, isUnicode);
}

export interface CharClassResult {
  cr: CharRange;
  next: number;
}

/** re_parse_nested_class (libregexp.c:1392-1547), CharRange-only reduction
 * (this file's header comment states the shared reachability evidence;
 * each excised region below cites its own guard and libregexp line range
 * per the lead's per-branch marking rider). `pos` points AT the opening
 * `[`. Does NOT apply /i case-folding (design §6.2: the class closure is
 * a SEPARATE compile-time pass over an assembled class — "runs in
 * TypeScript" — not inline per-atom canonicalization; this function
 * always builds the RAW class, matching libregexp's `!s->ignore_case`
 * path only. The closure pass itself is not yet built — later CP2
 * scope).
 *
 * EXCISED REGION 1 — nested `[...]` class recognition
 *   Guard: libregexp.c:1418, `if (*p == '[' && s->unicode_sets)`.
 *   A /v lift must port: the recursive re_parse_nested_class call and
 *   the `class_union` merge it feeds (libregexp.c:1418-1421, :1472-1477).
 *
 * EXCISED REGION 2 — "first char-class followed by '--'" special case
 *   Guard: libregexp.c:1428, `if (p[1] == '-' && s->unicode_sets && is_first)`.
 *   A /v lift must port: routing straight to class_atom instead of
 *   attempting a range when a set-subtraction op follows immediately.
 *
 * EXCISED REGION 3 — the `&&` (intersection) / `--` (subtraction) set-op block
 *   Guard: libregexp.c:1486, `if (s->unicode_sets && is_first)`.
 *   A /v lift must port: libregexp.c:1487-1523 in full (both the `&&`
 *   and `--` loops, each calling re_parse_class_set_operand — itself
 *   ENTIRELY unreachable without /v, since its only two call sites are
 *   inside this same excised region and the excised region-1 recursion,
 *   so re_parse_class_set_operand is not ported anywhere in this file).
 *
 * `is_first` (tracked by the reference to gate regions 2 and 3 only) is
 * dropped entirely — nothing else reads it. */
/** Case-closes ONE member's contribution before it is unioned into a
 * `[...]` combination. `dsw` true SKIPS closing entirely (used RAW,
 * regardless of ignoreCase) — a \d\D\s\S\w\W member; everything else
 * (a literal char, an explicit a-z-style range, a \p{...} property) DOES
 * get closed when ignoreCase is set. This split, and its ordering
 * relative to the class's own `[^...]` negation (closing happens PER
 * MEMBER, negation happens ONCE at the end, on the already-closed
 * union — see parseCharClass's own final `if (invert)` line, unchanged
 * by this function), was NOT read off one C function in one place: it
 * was reverse-engineered from lre_compile's actual byte output (see
 * ClassAtomResult's own doc for the specific probes: `[\w]/i` keeping
 * BOTH cases of \w unclosed, `[\wé]/i` closing 'é' while leaving \w raw
 * in the SAME class, `[^a-z]/i` negating the ALREADY-closed A-Z rather
 * than the raw a-z). Mirrors regex-parser.ts's closeIfIgnoreCase /
 * assertNoUnicodeCasefold guard (§6.3(a): /iu must never reach here) —
 * duplicated rather than imported, since regex-parser.ts imports FROM
 * this file at the value level (parseCharClass, getClassAtom) and the
 * reverse would be a real circular dependency, not just a type-only one. */
function closeMemberIfNeeded(cr: CharRange, ignoreCase: boolean, isUnicode: boolean, dsw: boolean): CharRange {
  if (!ignoreCase || dsw) return cr;
  if (isUnicode) {
    throw new Error(
      "regex-charclass: ignoreCase+isUnicode (simple case folding, /iu) reached character-class " +
        "compilation — this combination is refused (design §6.3) and must never reach here.",
    );
  }
  return caseCloseClass(cr);
}

export function parseCharClass(pattern: string, pos: number, isUnicode: boolean, ignoreCase = false): CharClassResult | null {
  let p = pos;
  if (pattern.charCodeAt(p) !== 0x5b /* '[' */) return null;
  p++;
  let invert = false;
  if (pattern.charCodeAt(p) === 0x5e /* '^' */) {
    p++;
    invert = true;
  }
  let cr: CharRange = [];
  for (;;) {
    if (p >= pattern.length) return null; // unterminated class (reference relies on buf_end via get_class_atom)
    if (pattern.charCodeAt(p) === 0x5d /* ']' */) break;
    const a1 = getClassAtom(pattern, p, true, isUnicode);
    if (a1 === null) return null;
    p = a1.next;

    if (pattern.charCodeAt(p) === 0x2d /* '-' */ && pattern.charCodeAt(p + 1) !== 0x5d) {
      if (a1.kind === "range") {
        // libregexp.c:1430-1437: a class-escape (e.g. \d) followed by
        // '-' can never form a range. Under /u this is invalid_class_range
        // (design §5.1: `[\w-a]` is Annex-B-only, REFUSE-dispositioned —
        // but that refusal is a compiler-support decision for a LATER
        // pass, not this parser's job; here it is simply a syntax
        // question, and Node itself rejects it under /u). Without /u,
        // Annex B treats the dash as a literal character belonging to
        // the NEXT atom, not this one — so `p` is deliberately NOT
        // advanced past the dash (matching the reference's `goto
        // class_atom` skipping its own `p = p0` assignment): a1 (the
        // range) is added alone, and the next loop iteration parses '-'
        // as its own ordinary literal atom.
        if (isUnicode) return null;
        cr = crOp(cr, closeMemberIfNeeded(a1.cr, ignoreCase, isUnicode, a1.dsw !== undefined), "union");
        continue;
      }
      const p0 = p + 1;
      const a2 = getClassAtom(pattern, p0, true, isUnicode);
      if (a2 === null) return null;
      if (a2.kind === "range") {
        // libregexp.c:1441-1447: symmetric case — the range's END would
        // be a class-escape. Same disposition as above: /u invalid, else
        // Annex B leaves the dash for the next iteration and a1 stands
        // alone (p is NOT advanced to p0).
        if (isUnicode) return null;
        cr = crOp(cr, closeMemberIfNeeded(crUnionInterval([], a1.cp, a1.cp), ignoreCase, isUnicode, false), "union");
        continue;
      }
      if (a2.cp < a1.cp) return null; // invalid_class_range: reversed order
      cr = crOp(cr, closeMemberIfNeeded(crUnionInterval([], a1.cp, a2.cp), ignoreCase, isUnicode, false), "union");
      p = a2.next;
      continue;
    }

    // class_atom (libregexp.c:1470-1484): no range formed, add a1 alone.
    if (a1.kind === "range") {
      cr = crOp(cr, closeMemberIfNeeded(a1.cr, ignoreCase, isUnicode, a1.dsw !== undefined), "union");
    } else {
      cr = crOp(cr, closeMemberIfNeeded(crUnionInterval([], a1.cp, a1.cp), ignoreCase, isUnicode, false), "union");
    }
  }
  p++; // skip ']'
  if (invert) cr = crInvert(cr);
  return { cr, next: p };
}

/** normal_char (libregexp.c:1217-1229). `p` points AT the character.
 * §5.4's named constraint is enforced HERE, not by the caller: under /u,
 * libregexp.c:1220-1225's `utf8_decode_len` combines a CESU-8-encoded
 * surrogate pair into one astral code point (the C-side equivalent of
 * `codePointAt` over a UTF-16 string); in non-unicode mode it does not —
 * a lone surrogate stays a lone surrogate, one code UNIT at a time (the
 * bug this comment now documents: an earlier version of this port called
 * `codePointAt` unconditionally, combining surrogate pairs even in
 * non-unicode mode — 1204's own witness pattern would have caught it via
 * the u-vs-non-u side-by-side comparison the design cites, but the
 * exhaustive test suite below catches it directly instead). */
function normalChar(pattern: string, p: number, isUnicode: boolean): ClassAtomResult | null {
  if (isUnicode) {
    const cp = pattern.codePointAt(p);
    if (cp === undefined) return null;
    return { kind: "char", cp, next: p + (cp >= 0x10000 ? 2 : 1) };
  }
  const cp = pattern.charCodeAt(p);
  if (Number.isNaN(cp)) return null;
  return { kind: "char", cp, next: p + 1 };
}
