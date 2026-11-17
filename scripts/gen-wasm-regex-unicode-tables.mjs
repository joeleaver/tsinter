// Regenerates packages/compiler/src/backend/wasm/regex-unicode-tables.ts
// from the vendored quickjs-ng General_Category tables (INC-24 P1). Run
// from the repo root:
//   node scripts/gen-wasm-regex-unicode-tables.mjs
// Mirrors gen-wasm-casing-tables.mjs exactly: the output is checked in
// (static data the wasm emitter/tsc-time \p{...} resolver embeds), this
// script READS the live vendored header at generation time (not a forked
// copy of its literals), and the drift test
// (wasm-regex-unicode-tables-drift.test.ts) re-parses the SAME header and
// byte-compares against the checked-in file.
//
// SCOPE (design §5.1's \p{...}/\P{...} row, §2.3 ground 5): General_Category
// ONLY — the 4,122-byte unicode_gc_table the design's own §2.3(5) already
// cites (measured: /\p{L}/u is the ONLY \p{...} usage anywhere in the 1077-
// program corpus, extract-patterns.mjs). Script (\p{Script=...}) and binary
// (\p{Alphabetic} etc.) properties use DIFFERENT table formats
// (unicode_script_table, unicode_prop_table[] — libunicode.c:1153/:1340) and
// are NOT ported here; the resolver this table backs returns a distinct
// "unsupported property" outcome for them rather than silently mismatching.
//
// PROPERTY RANGES (paperclip start-up: fast-string-truncated-width's
// CJKT_WIDE_RE / EMOJI_RE): a NAMED subset of Script values and binary
// properties, decoded HERE (unicode_script / unicode_prop1, libunicode.c
// :1153 / :1340, transcribed below) into flat [start, end) code point
// ranges, so the wasm compiler only copies a range list and never decodes
// those two formats. Scope is what a target site needs — every other Script
// value, Script_Extensions, and every other binary property still refuse as
// unported-unicode-property (SEMANTICS.md S102). Unicode version: the
// vendored header and Node v24.18.1 (process.versions.unicode 17.0) agree
// code point for code point on every ported property —
// wasm-regex-unicode-tables-drift.test.ts checks each one against the
// running Node's own \p{...} over all 0x110000 code points.
export const PORTED_SCRIPTS = ["Han", "Hiragana", "Katakana", "Hangul", "Tangut"];
export const PORTED_BINARY = ["Emoji", "Emoji_Modifier_Base", "Emoji_Modifier", "Emoji_Presentation"];
import { readFileSync, writeFileSync } from "node:fs";

const HEADER_PATH = "packages/runtime/vendor/quickjs-ng/libunicode-table.h";

function extractNumeric(header, name, expected) {
  const start = header.indexOf(`${name}[`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = header.indexOf("{", start);
  const close = header.indexOf("};", open);
  const body = header.slice(open + 1, close);
  const values = [...body.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => Number(m[0]));
  if (values.length !== expected) {
    throw new Error(`${name}: ${values.length} entries, expected ${expected}`);
  }
  return values;
}

/** unicode_gc_name_table is a C string literal built from concatenated
 * "alias1,alias2,..." "\0" segments (one segment per general-category
 * ROW, in enum order) — not a numeric array, so it needs its own parse:
 * pull every quoted segment between the `= ` and the terminating `;`,
 * concatenate them (matching C's string-literal concatenation), then
 * split on the embedded \0 markers into one alias-CSV string per row. */
function extractNameTable(header, name, expectedRows) {
  const start = header.indexOf(`${name}[]`);
  if (start < 0) throw new Error(`${name} not found`);
  const eq = header.indexOf("=", start);
  const semi = header.indexOf(";", eq);
  const body = header.slice(eq + 1, semi);
  const segments = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const joined = segments.join("");
  // Each row ends with a literal \0 (rendered as the two-char escape
  // sequence `\0` inside the quoted segment, per the header's own
  // spelling — see libunicode-table.h's `"...text..." "\0"` rows) — split
  // on that literal escape, drop the trailing empty segment after the
  // last \0.
  const rows = joined.split("\\0").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
  if (expectedRows >= 0 && rows.length !== expectedRows) {
    throw new Error(`${name}: ${rows.length} rows, expected ${expectedRows}`);
  }
  return rows;
}

/** A u8 table of any length (its declared size is the check). */
function extractBytes(header, name) {
  const m = new RegExp(`${name}\\[(\\d+)\\]`).exec(header);
  if (m === null) throw new Error(`${name} not found`);
  return extractNumeric(header, name, Number(m[1]));
}

/** Touching [start, end) pairs merged; the input is ascending. */
function mergeRanges(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) {
    if (out.length > 0 && out[out.length - 1] === pairs[i]) out[out.length - 1] = pairs[i + 1];
    else out.push(pairs[i], pairs[i + 1]);
  }
  return out;
}

/** unicode_script (libunicode.c:1153), is_ext = false, for one script's
 * enum value (name-table row + 1: the table omits Unknown, value 0). */
function decodeScript(table, scriptIdx) {
  const out = [];
  let p = 0;
  let c = 0;
  while (p < table.length) {
    const b = table[p++];
    const type = b >> 7;
    let n = b & 0x7f;
    if (n < 96) {
      // short run
    } else if (n < 112) {
      n = ((n - 96) << 8) | table[p++];
      n += 96;
    } else {
      n = (n - 112) << 16;
      n |= table[p++] << 8;
      n |= table[p++];
      n += 96 + (1 << 12);
    }
    const v = type === 0 ? 0 : table[p++];
    const c1 = c + n + 1;
    if (type !== 0 && v === scriptIdx) out.push(c, c1);
    c = c1;
  }
  return mergeRanges(out);
}

/** unicode_prop1 (libunicode.c:1340) over one unicode_prop_<Name>_table. */
function decodeProp(table) {
  const out = [];
  let p = 0;
  let c = 0;
  let bit = 0;
  while (p < table.length) {
    let c0 = c;
    const b = table[p++];
    if (b < 64) {
      c += (b >> 3) + 1;
      if (bit) out.push(c0, c);
      bit ^= 1;
      c0 = c;
      c += (b & 7) + 1;
    } else if (b >= 0x80) {
      c += b - 0x80 + 1;
    } else if (b < 0x60) {
      c += (((b - 0x40) << 8) | table[p]) + 1;
      p++;
    } else {
      c += (((b - 0x60) << 16) | (table[p] << 8) | table[p + 1]) + 1;
      p += 2;
    }
    if (bit) out.push(c0, c);
    bit ^= 1;
  }
  return mergeRanges(out);
}

/** The ported properties: one row per property, `kind` "sc" (a Script
 * value) or "bin" (a lone binary property name), `aliases` the header's
 * own alias CSV for it, `ranges` its flat [start, end) pairs. */
function extractProps(header) {
  const scriptNames = extractNameTable(header, "unicode_script_name_table", -1);
  const propNames = extractNameTable(header, "unicode_prop_name_table", -1);
  const scriptTable = extractBytes(header, "unicode_script_table");
  const rows = [];
  for (const name of PORTED_SCRIPTS) {
    const row = scriptNames.findIndex((r) => r.split(",")[0] === name);
    if (row < 0) throw new Error(`script ${name} not in the name table`);
    rows.push({ kind: "sc", aliases: scriptNames[row], ranges: decodeScript(scriptTable, row + 1) });
  }
  for (const name of PORTED_BINARY) {
    const aliases = propNames.find((r) => r.split(",")[0] === name);
    if (aliases === undefined) throw new Error(`property ${name} not in the name table`);
    rows.push({ kind: "bin", aliases, ranges: decodeProp(extractBytes(header, `unicode_prop_${name}_table`)) });
  }
  return rows;
}

/** Re-parses the vendored header and returns the General_Category data and
 * the ported property ranges in the same shape regex-unicode-tables.ts
 * exports. */
export function extractAll(headerText) {
  const header = headerText ?? readFileSync(HEADER_PATH, "utf8");
  return {
    gcTable: extractNumeric(header, "unicode_gc_table", 4122),
    gcNameRows: extractNameTable(header, "unicode_gc_name_table", 38),
    propRows: extractProps(header),
  };
}

function lines(values, perLine) {
  const rows = [];
  for (let i = 0; i < values.length; i += perLine) {
    rows.push("  " + values.slice(i, i + perLine).map((v) => `0x${v.toString(16)}`).join(", ") + ",");
  }
  return rows.join("\n");
}

function regenerate() {
  const { gcTable, gcNameRows, propRows } = extractAll();
  const nameRowsLiteral = gcNameRows.map((r) => `  ${JSON.stringify(r)},`).join("\n");
  const propRowsLiteral = propRows
    .map((r) => `  {\n    kind: ${JSON.stringify(r.kind)},\n    aliases: ${JSON.stringify(r.aliases)},\n    ranges: [\n    ${lines(r.ranges, 8).replace(/\n/g, "\n    ")}\n    ],\n  },`)
    .join("\n");
  writeFileSync(
    "packages/compiler/src/backend/wasm/regex-unicode-tables.ts",
    `/* GENERATED by scripts/gen-wasm-regex-unicode-tables.mjs — do not edit
 * by hand.
 * Source: ${HEADER_PATH}
 * Regenerate: node scripts/gen-wasm-regex-unicode-tables.mjs
 * Drift check: packages/compiler/test/wasm-regex-unicode-tables-drift.test.ts
 *   (re-parses the live vendored header and byte-compares against this
 *   file — catches a vendor bump that lands without regeneration)
 *
 * Unicode General_Category data, vendored from quickjs-ng's
 * libunicode-table.h — the same table libregexp.c's unicode_general_category
 * links against for \\p{...}/\\P{...} resolution (design §2.3 ground 5, §5.1's
 * \\p{...} row). SCOPE: General_Category, plus PROP_ROWS — a named subset of
 * Script values and binary properties, pre-decoded to ranges (see the
 * generator script's header comment).
 *
 * GC_TABLE: the compressed range-run byte stream (RLE, unicode_gc_table's
 * own format — libunicode.c:unicode_general_category1 decodes it: each
 * byte's top 3 bits are a short run length (7 = escape to a longer
 * length encoded in following bytes), the low 5 bits select which
 * general-category bit(s) the run belongs to, value 31 is the special
 * "alternating Lu/Ll" run). GC_NAME_ROWS: one alias-CSV string per
 * general-category, in enum order (index 0 = Cn ... 29 = Co, 30 = LC,
 * 31 = L, 32 = M, 33 = N, 34 = S, 35 = P, 36 = Z, 37 = C) — the SAME
 * order unicode_gc_mask_table uses for the composite (index >= 30)
 * entries, so a consumer's enum must match this array's index exactly. */

export const GC_TABLE: readonly number[] = [
${lines(gcTable, 8)}
];

export const GC_NAME_ROWS: readonly string[] = [
${nameRowsLiteral}
];

/** The ported Script values (kind "sc", reached by \\p{Script=…} /
 * \\p{sc=…}) and binary properties (kind "bin", reached by a lone
 * \\p{…} name), decoded by the generator from unicode_script_table /
 * unicode_prop_<Name>_table into flat [start, end) code point pairs.
 * Every other Script value and binary property is unported (SEMANTICS.md
 * S102). */
export interface PropRow {
  readonly kind: "sc" | "bin";
  readonly aliases: string;
  readonly ranges: readonly number[];
}

export const PROP_ROWS: readonly PropRow[] = [
${propRowsLiteral}
];
`,
  );
  console.log(`wrote regex-unicode-tables.ts: gcTable=${gcTable.length} gcNameRows=${gcNameRows.length} propRows=${propRows.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  regenerate();
}
