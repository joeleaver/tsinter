/* Unit P1 (the RegExp compiler): the tables the wasm-emitted compiler
 * (regex-compiler.ts) embeds, the class tables the interpreter shares with
 * it, and the outcome vocabulary (V8 SyntaxError texts, fence keys) its
 * callers read.
 *
 * Every derived table is computed, at compiler-process time, from a
 * primitive that holds the data once:
 *   - the identifier tables come from regex-ident.ts's isIdentFirst /
 *     isIdentNext (Node's own \p{ID_Start} / \p{ID_Continue});
 *   - the case-closure table comes from regex-canon.ts's canonicalize (the
 *     measured-Node-exact non-unicode Canonicalize);
 *   - the General_Category alias list comes from regex-unicode-tables.ts's
 *     GC_NAME_ROWS.
 * Each is computed once per process, on first use. */
import { canonicalize } from "./regex-canon.js";
import { isIdentFirst, isIdentNext } from "./regex-ident.js";
import { GC_NAME_ROWS } from "./regex-unicode-tables.js";

/* ── outcome vocabulary ─────────────────────────────────────────────── */

/** A V8 SyntaxError reason the runtime compiler reports by text. The id is
 * the index into RX_SYNTAX_TEXT (0 is "no error"). Every text here is V8's
 * own wording, measured against Node v24.18.1 (the gate in
 * wasm-regex-runtime-compiler.test.ts compares every reported message with
 * Node's for the whole pattern pool). */
export const RX_SYNTAX_TEXT: readonly string[] = [
  "", // 0: ok
  "Nothing to repeat",
  "Lone quantifier brackets",
  "numbers out of order in {} quantifier",
  "Incomplete quantifier",
  "Invalid group",
  "Invalid capture group name",
  "Duplicate capture group name",
  "Invalid named capture referenced",
  "Invalid named reference",
  "Invalid property name",
  "Range out of order in character class",
  "Invalid character class",
  "Invalid escape",
  "Invalid Unicode escape",
  "\\ at end of pattern",
  "Repeated flag in flag group",
  "Invalid flag group",
  "Unterminated group",
  "Unmatched ')'",
  "Unterminated character class",
  "Invalid quantifier",
  "Invalid decimal escape",
  "Multiple dashes in flag group",
  "Invalid property name in character class",
];

export const RX = {
  OK: 0,
  NOTHING_TO_REPEAT: 1,
  LONE_QUANT: 2,
  NUM_ORDER: 3,
  INCOMPLETE_QUANT: 4,
  INVALID_GROUP: 5,
  INVALID_CAP_NAME: 6,
  DUP_NAME: 7,
  INVALID_NAMED_CAPTURE_REF: 8,
  INVALID_NAMED_REF: 9,
  INVALID_PROP_NAME: 10,
  RANGE_ORDER: 11,
  INVALID_CLASS: 12,
  INVALID_ESCAPE: 13,
  INVALID_UNICODE_ESCAPE: 14,
  BACKSLASH_END: 15,
  REPEATED_FLAG: 16,
  INVALID_FLAG_GROUP: 17,
  UNTERMINATED_GROUP: 18,
  UNMATCHED_PAREN: 19,
  UNTERMINATED_CLASS: 20,
  INVALID_QUANTIFIER: 21,
  INVALID_DECIMAL_ESCAPE: 22,
  MULTIPLE_DASHES: 23,
  INVALID_PROP_NAME_CLASS: 24,
  /** "Invalid flags supplied to RegExp constructor '<raw flags>'" — its own
   * message shape (no pattern, raw flags echoed). */
  BAD_FLAGS: 60,
  /** First fence id; RX_FENCE_KEY[id - FENCE_BASE] is the key. */
  FENCE_BASE: 100,
} as const;

/** The named fences: a pattern or flags string this tier does not build
 * (SEMANTICS.md S102). Keys are the build-time refusal keys' own text
 * (`libCall:regex.new:<key>`), so the census and the run-time error speak
 * one vocabulary. */
export const RX_FENCE_KEY: readonly string[] = [
  "unicode-sets-flag",
  "unicode-casefold",
  "modifiers",
  "unported-unicode-property",
  "annexb-quantified-assertion",
  "annexb-extended-pattern-char",
  "annexb-brace-literal",
  "annexb-legacy-octal",
  "annexb-nonoctal-decimal",
  "annexb-control-escape",
  "annexb-class-range-escape",
  "annexb-named-backref-leniency",
  "too-many-captures",
  "too-many-registers",
  "too-many-ranges",
  "nesting-depth",
  "pattern-too-large",
];

/** Above this many UTF-16 code units a pattern is fenced
 * (`pattern-too-large`, SEMANTICS.md S102): V8 compiles a regex lazily, at
 * its first match, and throws "Regular expression too large" or "Stack
 * overflow" there for a large pattern — at a size that depends on the
 * construct mix and the native stack (measured with Node v24.18.1: 14,008
 * code units of `a+` under /u is the smallest failing pattern found;
 * 32,768 plain characters fail), so there is no crisp limit to mirror. */
export const RX_PATTERN_SIZE_LIMIT = 8192;

export function fenceId(key: string): number {
  const i = RX_FENCE_KEY.indexOf(key);
  if (i < 0) throw new Error(`regex-compiler-tables: unknown fence key ${key}`);
  return RX.FENCE_BASE + i;
}

/** V8's own message text for a syntax reason over a pattern and its flags:
 * the RAW pattern text and the CANONICAL flags (V8 prints the flags getter's
 * order, so `new RegExp("(", "ig")` reports `/(/gi`). */
export function v8SyntaxMessage(pattern: string, flags: string, reason: string): string {
  return `Invalid regular expression: /${pattern}/${canonicalFlagsV8(flags)}: ${reason}`;
}

/** The RegExp flags getter's order (hasIndices, global, ignoreCase,
 * multiline, dotAll, unicode, unicodeSets, sticky). */
export function canonicalFlagsV8(flags: string): string {
  return "dgimsuvy"
    .split("")
    .filter((c) => flags.includes(c))
    .join("");
}

/** The run-time fence's message and code (SEMANTICS.md S102). */
export function fenceMessage(key: string): string {
  return `new RegExp(): '${key}' is not supported yet`;
}
export function fenceCode(key: string): string {
  return `libCall:regex.new:${key}`;
}

/* ── class tables ───────────────────────────────────────────────────── */

/** A set of code points as sorted [start, end) boundary pairs (libunicode's
 * CharRange). */
export type CharRange = readonly number[];

/** cr_invert (libunicode.c:522): a 0 boundary in front and the 0xffffffff
 * sentinel behind, then empty intervals dropped (cr_compress's job on this
 * input: only a leading [0, 0) or trailing [x, x) can be empty). */
function crInvert(cr: CharRange): CharRange {
  const pts = [0, ...cr, 0xffffffff];
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) if (pts[i] !== pts[i + 1]) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/* \d \s \w (libregexp.c:404-433 char_range_table); the uppercase forms are
 * cr_invert of the lowercase ones, as cr_init_char_range computes them. */
const CHAR_RANGE_D: CharRange = [0x0030, 0x003a];
const CHAR_RANGE_S: CharRange = [
  0x0009, 0x000e, 0x0020, 0x0021, 0x00a0, 0x00a1, 0x1680, 0x1681, 0x2000, 0x200b, 0x2028, 0x202a, 0x202f, 0x2030,
  0x205f, 0x2060, 0x3000, 0x3001, 0xfeff, 0xff00,
];
const CHAR_RANGE_W: CharRange = [0x0030, 0x003a, 0x0041, 0x005b, 0x005f, 0x0060, 0x0061, 0x007b];

export type DsWClass = "d" | "D" | "s" | "S" | "w" | "W";

/** cr_init_char_range (libregexp.c:452): \d\D\s\S\w\W as CharRanges. */
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

/* General_Category masks (libunicode.c unicode_gc_mask_table): every alias
 * of every GC_NAME_ROWS row resolves to its row index; rows up to Co are
 * the 30 single-bit categories, the 8 after them composites. */
const GC_IDX: Readonly<Record<string, number>> = Object.fromEntries(
  GC_NAME_ROWS.flatMap((row, i) => row.split(",").map((alias) => [alias, i] as const)),
);
const GC_CO_IDX = GC_IDX["Co"]!;
const GC_LC_IDX = GC_IDX["LC"]!;
const gcBit = (shortName: string): number => 1 << GC_IDX[shortName]!;
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

/** The category mask a GC_NAME_ROWS row resolves to. */
export function gcRowMask(row: number): number {
  return row <= GC_CO_IDX ? 1 << row : GC_COMPOSITE_MASK[row - GC_LC_IDX]!;
}
/** The Lu / Ll bits GC_TABLE's alternating-run marker decodes into. */
export const GC_LU_BIT = gcBit("Lu");
export const GC_LL_BIT = gcBit("Ll");

/* ── derived tables ─────────────────────────────────────────────────── */

function rangesOf(pred: (cp: number) => boolean): number[] {
  const out: number[] = [];
  let start = -1;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const inside = cp < 0x110000 && pred(cp);
    if (inside && start < 0) start = cp;
    else if (!inside && start >= 0) {
      out.push(start, cp);
      start = -1;
    }
  }
  return out;
}

let identFirstCache: number[] | null = null;
let identNextCache: number[] | null = null;
let canonPairsCache: number[] | null = null;

/** [start, end) pairs of every code point isIdentFirst accepts. */
export function identFirstRanges(): readonly number[] {
  identFirstCache ??= rangesOf(isIdentFirst);
  return identFirstCache;
}

/** [start, end) pairs of every code point isIdentNext accepts. */
export function identNextRanges(): readonly number[] {
  identNextCache ??= rangesOf(isIdentNext);
  return identNextCache;
}

/** (x, canonicalize(x)) for every code point canonicalize moves, ascending
 * in x — the whole non-identity part of Canonicalize. The case closure of a
 * set S is then (S minus these x) united with { canonicalize(x) : x in S },
 * the same set caseCloseClass builds by visiting every member. */
export function canonPairs(): readonly number[] {
  if (canonPairsCache === null) {
    const out: number[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      const k = canonicalize(cp);
      if (k !== cp) out.push(cp, k);
    }
    canonPairsCache = out;
  }
  return canonPairsCache;
}

/** The General_Category aliases as one blob: per alias, [len][ASCII
 * bytes][row index]. Row order is GC_NAME_ROWS's, which is the order
 * unicodeGeneralCategory's mask computation keys on. */
export function gcAliasBlob(): Uint8Array {
  const bytes: number[] = [];
  GC_NAME_ROWS.forEach((row, i) => {
    for (const alias of row.split(",")) {
      bytes.push(alias.length);
      for (let k = 0; k < alias.length; k++) bytes.push(alias.charCodeAt(k));
      bytes.push(i);
    }
  });
  return Uint8Array.from(bytes);
}

/** Little-endian i32 bytes for array.new_data over an i32 array type. */
export function i32Bytes(vals: readonly number[]): Uint8Array {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setInt32(i * 4, v | 0, true));
  return out;
}
