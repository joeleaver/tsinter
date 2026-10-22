// Generates packages/compiler/src/backend/wasm/url-tables.ts from Node
// v24.18.1's vendored ada (deps/ada/ada.cpp + ada.h, ada 3.4.4), fetched
// from the nodejs/node tag v24.18.1.
// usage: node packages/compiler/test/gen-url-tables.mjs <deps/ada dir> packages/compiler/src/backend/wasm/url-tables.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [adaDir, outPath] = process.argv.slice(2);
const cpp = readFileSync(join(adaDir, "ada.cpp"), "utf8");
const h = readFileSync(join(adaDir, "ada.h"), "utf8");

function body(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`missing ${decl}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${decl}`);
}
function nums(text) {
  const noComments = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...noComments.matchAll(/0x[0-9a-fA-F]+|\d+/g)].map((m) => Number(m[0]));
}
function grid(text, rows, width) {
  const groups = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => nums(m[1]));
  if (groups.length > rows) throw new Error(`grid: ${groups.length} rows > ${rows}`);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const g = groups[r] ?? [];
    if (g.length > width) throw new Error(`grid row ${r}: ${g.length} > ${width}`);
    for (let c = 0; c < width; c++) out.push(g[c] ?? 0);
  }
  return out;
}
function pad(a, n) {
  if (a.length > n) throw new Error(`pad: ${a.length} > ${n}`);
  while (a.length < n) a.push(0);
  return a;
}
function pctSet(name) {
  const b = body(h, `constexpr uint8_t ${name}[32] =`);
  const noComments = b.replace(/\/\/[^\n]*/g, "");
  const rows = noComments.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
  if (rows.length !== 32) throw new Error(`${name}: ${rows.length} rows`);
  return rows.map((r) => r.split("|").map((x) => Number(x.trim())).reduce((a, v) => a | v, 0));
}

function packU8(a) {
  return Buffer.from(Uint8Array.from(a));
}
function packU24(a) {
  const b = Buffer.alloc(a.length * 3);
  a.forEach((v, i) => {
    if (v < 0 || v > 0xffffff) throw new Error(`u24 overflow ${v}`);
    b[i * 3] = v & 255;
    b[i * 3 + 1] = (v >> 8) & 255;
    b[i * 3 + 2] = v >> 16;
  });
  return b;
}
/** Rows of 257 monotone u16: each row is its first value (u16) and 256
 * byte deltas. */
function packRowDelta(a) {
  if (a.length % 257 !== 0) throw new Error("rowdelta: not 257-wide");
  const b = Buffer.alloc((a.length / 257) * 258);
  for (let r = 0; r < a.length / 257; r++) {
    const row = a.slice(r * 257, r * 257 + 257);
    b.writeUInt16LE(row[0], r * 258);
    for (let k = 1; k < 257; k++) {
      const d = row[k] - row[k - 1];
      if (d < 0 || d > 255) throw new Error(`rowdelta: delta ${d} at row ${r} col ${k}`);
      b[r * 258 + 1 + k] = d;
    }
  }
  return b;
}
function packU32(a) {
  const b = Buffer.alloc(a.length * 4);
  a.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

const out = {};
const counts = {};
function put(name, arr, pack, expect) {
  if (expect !== undefined && arr.length !== expect) throw new Error(`${name}: ${arr.length} != ${expect}`);
  out[name] = pack(arr);
  counts[name] = arr.length;
}

// Percent-encode sets, in this order.
const SETS = ["C0_CONTROL_PERCENT_ENCODE", "SPECIAL_QUERY_PERCENT_ENCODE", "QUERY_PERCENT_ENCODE", "FRAGMENT_PERCENT_ENCODE", "USERINFO_PERCENT_ENCODE", "PATH_PERCENT_ENCODE"];
put("PCT_SETS", SETS.flatMap(pctSet), packU8, 32 * SETS.length);

put("IDNA_MAPPINGS", pad(nums(body(cpp, "const uint32_t mappings[5264] =")), 5264), packU24, 5264);
{
  const t = grid(body(cpp, "const uint32_t table[8198][2] ="), 8198, 2);
  put("IDNA_START", t.filter((_, i) => i % 2 === 0), packU24, 8198);
  put("IDNA_DESC", t.filter((_, i) => i % 2 === 1), packU32, 8198);
}
put("DECOMP_INDEX", pad(nums(body(cpp, "const uint8_t decomposition_index[4352] =")), 4352), packU8, 4352);
put("DECOMP_BLOCK", grid(body(cpp, "const uint16_t decomposition_block[67][257] ="), 67, 257), packRowDelta, 67 * 257);
put("DECOMP_DATA", pad(nums(body(cpp, "const char32_t decomposition_data[9102] =")), 9102), packU24, 9102);
put("CCC_INDEX", pad(nums(body(cpp, "const uint8_t canonical_combining_class_index[4352] =")), 4352), packU8, 4352);
put("CCC_BLOCK", grid(body(cpp, "const uint8_t canonical_combining_class_block[67][256] ="), 67, 256), packU8, 67 * 256);
put("COMP_INDEX", pad(nums(body(cpp, "const uint8_t composition_index[4352] =")), 4352), packU8, 4352);
put("COMP_BLOCK", grid(body(cpp, "const uint16_t composition_block[67][257] ="), 67, 257), packRowDelta, 67 * 257);
put("COMP_DATA", pad(nums(body(cpp, "const char32_t composition_data[1883] =")), 1883), packU24, 1883);

// Bidi directions: {start, final, direction::X} triples; the enum order is
// validity.cpp's own.
const DIRS = ["NONE", "BN", "CS", "ES", "ON", "EN", "L", "R", "NSM", "AL", "AN", "ET", "WS", "RLO", "LRO", "PDF", "RLE", "RLI", "FSI", "PDI", "LRI", "B", "S", "LRE"];
{
  const enumBody = body(cpp, "enum direction : uint8_t");
  const names = enumBody.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.join(",") !== DIRS.join(",")) throw new Error(`direction enum drifted: ${names.join(",")}`);
  const b = body(cpp, "static directions dir_table[] =");
  const triples = [...b.matchAll(/\{\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*direction::([A-Z]+)\s*\}/g)];
  const flat = [];
  for (const t of triples) {
    const d = DIRS.indexOf(t[3]);
    if (d < 0) throw new Error(`unknown direction ${t[3]}`);
    flat.push(Number(t[1]), Number(t[2]), d);
  }
  counts.DIR_ENTRIES = triples.length;
  put("DIR_START", flat.filter((_, i) => i % 3 === 0), packU24);
  put("DIR_FINAL", flat.filter((_, i) => i % 3 === 1), packU24);
  put("DIR_DIR", flat.filter((_, i) => i % 3 === 2), packU8);
}
put("COMBINING", nums(body(cpp, "constexpr static uint32_t combining[] =")), packU24);
{
  const c = nums(body(cpp, "constexpr static uint32_t combining[] ="));
  for (let i = 1; i < c.length; i++) if (c[i] <= c[i - 1]) throw new Error("combining not sorted");
}
// Small ContextJ lists (validity.cpp): asserted, then hardcoded in the builder.
const virama = nums(body(cpp, "constexpr static uint32_t virama[] ="));
const R = nums(body(cpp, "constexpr static uint32_t R[] ="));
const L = nums(body(cpp, "constexpr static uint32_t L[] ="));
const D = nums(body(cpp, "constexpr static uint32_t D[] ="));

let ts = `/* GENERATED from Node v24.18.1's vendored ada (deps/ada/ada.cpp and ada.h —
 * ada 3.4.4, IDNA 17.0.0) by packages/compiler/test/gen-url-tables.mjs, run
 * on deps/ada from the nodejs/node tag v24.18.1. Do not edit by hand.
 *
 * Every table is ada's own C array, packed little-endian and base64-wrapped
 * so this file stays small; url-whatwg.ts and url-idna.ts intern each one
 * into the module's data segment and unpack it on first use. Packings:
 * u8 / u24 / u32 (a code point never needs more than 24 bits), and
 * "rowdelta" for the two 67 x 257 u16 normalization blocks, whose rows
 * are monotone: each row is its first value (u16) and 256 byte deltas.
 *   PCT_SETS        u8, 6 x 32-byte bitsets: C0 control, special-query,
 *                   query, fragment, userinfo, path (ada::character_sets)
 *   IDNA_START      u24, mapping_tables.cpp table[i][0]
 *   IDNA_DESC       u32, mapping_tables.cpp table[i][1]
 *   IDNA_MAPPINGS   u24, mapping_tables.cpp mappings
 *   DECOMP_INDEX / CCC_INDEX / COMP_INDEX / CCC_BLOCK  u8
 *   DECOMP_BLOCK / COMP_BLOCK  rowdelta
 *   DECOMP_DATA / COMP_DATA    u24
 *   DIR_START / DIR_FINAL      u24, DIR_DIR u8: validity.cpp dir_table
 *                   (the direction is the enum's ordinal)
 *   COMBINING       u24, sorted (validity.cpp is_label_valid's combining)
 */
`;
const sha = createHash("sha256");
for (const [name, buf] of Object.entries(out)) {
  sha.update(name).update(buf);
  ts += `\n/** ${counts[name]} entries, ${buf.length} bytes. */\nexport const URL_${name} = ${JSON.stringify(buf.toString("base64"))};\n`;
}
ts += `\n/** validity.cpp is_label_valid's ContextJ lists. */\nexport const URL_VIRAMA: readonly number[] = ${JSON.stringify(virama)};\nexport const URL_JOIN_R: readonly number[] = ${JSON.stringify(R)};\nexport const URL_JOIN_L: readonly number[] = ${JSON.stringify(L)};\nexport const URL_JOIN_D: readonly number[] = ${JSON.stringify(D)};\n`;
ts += `\n/** Decode one table. */\nexport function urlTableBytes(b64: string): Uint8Array {\n  return Uint8Array.from(Buffer.from(b64, "base64"));\n}\n`;
writeFileSync(outPath, ts);
console.log(JSON.stringify(counts), "total bytes", Object.values(out).reduce((a, b) => a + b.length, 0), "sha", sha.digest("hex").slice(0, 16));
