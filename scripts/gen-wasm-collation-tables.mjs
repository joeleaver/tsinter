// Regenerates packages/compiler/src/backend/wasm/collation-tables.ts — the
// root collation Node's ICU uses for String.prototype.localeCompare (and
// Intl.Collator) with no locale, as compact streams the WasmGC runtime
// (collation.ts) unpacks on first use. Run from the repo root:
//   node scripts/gen-wasm-collation-tables.mjs [<source dir>]
// <source dir> defaults to ~/.cache/tsinter-dl/cldr-48-uca and must hold the
// files below with exactly these sha256 digests (checked before anything is
// read). Node v24.18.1 ships ICU 78.3 / CLDR 48.0 / Unicode 17.0.
//
// Inputs:
//   FractionalUCA.txt https://raw.githubusercontent.com/unicode-org/icu/release-78.3/icu4c/source/data/unidata/FractionalUCA.txt
//                     ICU 78.3's root collation data, the file ICU's genuca
//                     builds the root collator from (byte-identical to CLDR
//                     48's common/uca/FractionalUCA_SHORT.txt). Unlike DUCET /
//                     allkeys_CLDR.txt it orders Han in radical-stroke order
//                     ([radical …] lines), gives Tangut / Nushu / Khitan
//                     explicit weights, and has prefix ("x | y") rules.
//   UnicodeData.txt   https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
//                     canonical decompositions + Canonical_Combining_Class (NFD)
//
// Weights. ICU compares collation elements level by level as left-aligned
// integers (32-bit primaries, 16-bit secondaries, tertiaries masked with
// 0x3F3F — the two case bits atop each tertiary byte drop out when caseFirst
// is off, as it is for root). Only the ORDER of weights matters, so each
// level's distinct weights are replaced by dense ranks. Primaries:
//   1..R            explicit weights, ascending; in the Han / implicit lead
//                   bytes 81..E4 only "FDD1 5B57" (Han's first primary, 81 02
//                   02) and "FDD1 FDD0" (the unassigned first primary, E4) —
//                   the generator checks
//   Han             in radical-stroke order, after every explicit primary
//                   below lead byte E0 and before the E4 one
//   implicit        every code point with no mapping (unassigned, private use,
//                   noncharacters, lone surrogates), by code point, after
//                   "FDD1 FDD0" and before the explicit primaries with lead
//                   byte >= E5 (U+FFFD, U+FFFF)
//
// What is kept: the runtime NFD-normalizes both strings before collating
// (V8 turns ICU's normalization mode on for every collator, and ICU's root
// data is canonically closed, so collating the NFD form is the same
// comparison), so no mapping whose key holds a character with a canonical
// decomposition can ever be looked up — those rows are dropped. Hangul
// syllables decompose algorithmically and carry no rows.
//
// The drift test (packages/compiler/test/wasm-collation-tables-drift.test.ts)
// imports build()/render() and byte-compares against the checked-in file
// whenever the source directory is present.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SOURCE_DIR = join(homedir(), ".cache/tsinter-dl/cldr-48-uca");
export const OUT_PATH = "packages/compiler/src/backend/wasm/collation-tables.ts";

export const SOURCES = {
  "FractionalUCA.txt": {
    url: "https://raw.githubusercontent.com/unicode-org/icu/release-78.3/icu4c/source/data/unidata/FractionalUCA.txt",
    sha256: "d7cdfab860bf94c6f470c1fae39b81619a12f3a51f80d7cad1ba08404dec3de6",
  },
  "UnicodeData.txt": {
    url: "https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt",
    sha256: "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c",
  },
};

/** The Unicode 17 blocks holding the Han characters FractionalUCA orders
 * (CJK Unified Ideographs Extension A, the URO, Compatibility Ideographs,
 * Extensions B, C, D, E, F, I, G, H, J): the HAN stream reads each run
 * against its block's cursor. */
export const HAN_BLOCKS = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf], [0x2ceb0, 0x2ebef],
  [0x2ebf0, 0x2ee5f], [0x30000, 0x3134f], [0x31350, 0x323af], [0x323b0, 0x3347f],
];

export function sourcesPresent(dir = DEFAULT_SOURCE_DIR) {
  return Object.keys(SOURCES).every((f) => existsSync(join(dir, f)));
}

function readSource(dir, name) {
  const buf = readFileSync(join(dir, name));
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== SOURCES[name].sha256) {
    throw new Error(`${name}: sha256 ${got}, expected ${SOURCES[name].sha256} (${SOURCES[name].url})`);
  }
  return buf.toString("utf8");
}

/* ── encoding helpers ─────────────────────────────────────────────────── */

class Bytes {
  constructor() {
    this.a = [];
  }
  /** unsigned LEB128 (u32) */
  u(v) {
    if (v < 0 || v > 0xffffffff || !Number.isInteger(v)) throw new Error(`varint out of range: ${v}`);
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v) b |= 0x80;
      this.a.push(b);
    } while (v);
  }
  u8(v) {
    if (v < 0 || v > 255) throw new Error(`byte out of range: ${v}`);
    this.a.push(v);
  }
  /** zigzag LEB128 of a 32-bit two's-complement value (decoders add mod 2^32) */
  s(v) {
    v |= 0;
    this.u(v < 0 ? -2 * v - 1 : 2 * v);
  }
  get length() {
    return this.a.length;
  }
  b64() {
    return Buffer.from(this.a).toString("base64");
  }
}

const hexBytes = (s) => (s.trim() === "" ? [] : s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
/** left-aligned value of a weight's bytes in `width` bytes */
const leftAligned = (bytes, width) => {
  if (bytes.length > width) throw new Error(`weight wider than ${width} bytes: ${bytes}`);
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + (bytes[i] ?? 0);
  return v;
};

/* ── build ────────────────────────────────────────────────────────────── */

export function build(dir = DEFAULT_SOURCE_DIR) {
  const frac = readSource(dir, "FractionalUCA.txt");
  const ud = readSource(dir, "UnicodeData.txt");

  // NFD data
  const ccc = new Map();
  const rawDecomp = new Map();
  for (const l of ud.split("\n")) {
    if (!l) continue;
    const f = l.split(";");
    const cp = parseInt(f[0], 16);
    if (+f[3]) ccc.set(cp, +f[3]);
    if (f[5] && !f[5].startsWith("<")) rawDecomp.set(cp, f[5].split(" ").map((h) => parseInt(h, 16)));
  }
  const full = (cp) => {
    const d = rawDecomp.get(cp);
    return d ? d.flatMap(full) : [cp];
  };
  const decomp = new Map([...rawDecomp.keys()].map((cp) => [cp, full(cp)]));
  const decomposable = (cp) => decomp.has(cp) || (cp >= 0xac00 && cp <= 0xd7a3);

  // Han, radical-stroke order
  const han = [];
  for (const l of frac.split("\n")) {
    if (!l.startsWith("[radical ") || l.startsWith("[radical end")) continue;
    const cps = [...l.slice(l.indexOf(":") + 1, l.lastIndexOf("]"))].map((c) => c.codePointAt(0));
    for (let i = 0; i < cps.length; i++) {
      if (cps[i + 1] === 0x2d && i + 2 < cps.length) {
        for (let c = cps[i]; c <= cps[i + 2]; c++) han.push(c);
        i += 2;
      } else han.push(cps[i]);
    }
  }
  const hanIndex = new Map(han.map((c, i) => [c, i]));
  if (hanIndex.size !== han.length) throw new Error("a Han character listed twice");

  // mappings: [{ key: cp[], prefix: cp | null, ces: raw CE[] }]
  // a raw CE: { p: bytes[] | { han: cp }, s: bytes[], t: bytes[] }
  const rows = [];
  for (const line of frac.split("\n")) {
    if (!/^[0-9A-F]/.test(line)) continue;
    const semi = line.indexOf(";");
    const keyPart = line.slice(0, semi);
    let ceText = line.slice(semi + 1);
    const hash = ceText.indexOf("#");
    if (hash >= 0) ceText = ceText.slice(0, hash);
    let prefix = null;
    let key;
    if (keyPart.includes("|")) {
      const [pre, k] = keyPart.split("|");
      const pcs = hexBytes(pre).length ? pre.trim().split(/\s+/).map((h) => parseInt(h, 16)) : [];
      if (pcs.length !== 1) throw new Error(`prefix of length != 1: ${line}`);
      prefix = pcs[0];
      key = k.trim().split(/\s+/).map((h) => parseInt(h, 16));
    } else key = keyPart.trim().split(/\s+/).map((h) => parseInt(h, 16));
    const ces = [];
    const ceRe = /\[([^\]]*)\]/g;
    let m;
    let consumed = "";
    while ((m = ceRe.exec(ceText))) {
      consumed += m[0];
      const parts = m[1].split(",");
      if (parts[0].trim().startsWith("U+")) {
        const ref = parseInt(parts[0].trim().slice(2), 16);
        if (!hanIndex.has(ref)) throw new Error(`[U+…] to a non-Han character: ${line}`);
        // [U+X] / [U+X, T] / [U+X, S, T]: X's primary, common (05) weights where omitted
        const s = parts.length === 3 ? hexBytes(parts[1]) : [0x05];
        const t = parts.length >= 2 ? hexBytes(parts[parts.length - 1]) : [0x05];
        ces.push({ p: { han: ref }, s, t });
      } else {
        if (parts.length !== 3) throw new Error(`CE without three weights: ${line}`);
        ces.push({ p: hexBytes(parts[0]), s: hexBytes(parts[1]), t: hexBytes(parts[2]) });
      }
    }
    if (consumed.replace(/\s/g, "") !== ceText.replace(/\s/g, "")) throw new Error(`unparsed CE text: ${line}`);
    if (ces.length === 0) throw new Error(`no CEs: ${line}`);
    // "FDD0 x" rows are FractionalUCA's own markers (the numeric lead byte,
    // the reorder-reserved boundaries, constructed level samples): ICU's
    // builder carries none of them into the root collator — U+FDD0 takes
    // its implicit weight in Node whatever follows (measured).
    if (key[0] === 0xfdd0) continue;
    rows.push({ key, prefix, ces });
  }

  // ranks
  const prims = new Set();
  const secs = new Set();
  const ters = new Set();
  for (const r of rows) {
    for (const ce of r.ces) {
      if (Array.isArray(ce.p) && ce.p.length) {
        const lead = ce.p[0];
        const v = leftAligned(ce.p, 4);
        // the two explicit weights among the Han / implicit lead bytes: "FDD1
        // 5B57", the Han script's first primary (below every Han character),
        // and "FDD1 FDD0", the unassigned first primary (above Han, below
        // every implicit weight)
        if (lead >= 0x81 && lead <= 0xe4 && v !== 0x81020200 && v !== 0xe4000000) {
          throw new Error(`explicit primary in the Han/implicit lead bytes: ${ce.p}`);
        }
        prims.add(v);
      }
      if (ce.s.length) secs.add(leftAligned(ce.s, 2));
      if (ce.t.length) ters.add(leftAligned(ce.t, 2) & 0x3f3f);
    }
  }
  const sortN = (s) => [...s].sort((a, b) => a - b);
  const primRank = new Map(sortN(prims).map((v, i) => [v, i + 1]));
  const secRank = new Map(sortN(secs).map((v, i) => [v, i + 1]));
  if (ters.has(0)) throw new Error("a tertiary weight of only case bits");
  const terRank = new Map(sortN(ters).map((v, i) => [v, i + 1]));
  if (ters.size >= 1 << 5) throw new Error(`${ters.size} tertiaries do not fit 5 bits`);
  const R = prims.size;
  const R1 = sortN(prims).filter((v) => v < 0xe0000000).length;
  const R2 = sortN(prims).filter((v) => v < 0xe5000000).length;
  if (R >= 1 << 16) throw new Error(`${R} primaries do not fit 16 bits`);
  if (secs.size >= 1 << 9) throw new Error(`${secs.size} secondaries do not fit 9 bits`);
  if (han.length + R + 1 >= 1 << 18) throw new Error("Han references do not fit 18 bits");

  /* A packed CE (u32): P << 14 | s << 5 | t, where P is 0 (ignorable), a
   * primary rank 1..R, or R + 1 + Han index; s a secondary rank (0 =
   * ignorable); t the masked tertiary. */
  const pack = (ce) => {
    const P = Array.isArray(ce.p) ? (ce.p.length ? primRank.get(leftAligned(ce.p, 4)) : 0) : R + 1 + hanIndex.get(ce.p.han);
    const s = ce.s.length ? secRank.get(leftAligned(ce.s, 2)) : 0;
    const t = ce.t.length ? terRank.get(leftAligned(ce.t, 2) & 0x3f3f) : 0;
    return P * 16384 + s * 32 + t;
  };

  // keep what NFD text can reach
  const single = new Map();
  const contractions = new Map();
  const prefixes = new Map();
  for (const r of rows) {
    // One contraction ends in a Hangul syllable, "FDD1 AC00" (Hangul's
    // first primary). ICU matches it against the syllable itself, before
    // its algorithmic decomposition and with no canonically closed twin
    // (U+FDD1 U+1100 U+1161 does not match), so it is kept, and the runtime
    // leaves a U+AC00 that directly follows U+FDD1 undecomposed
    // (COLL_HANGUL_CTR).
    const hangulCtr = r.key.length === 2 && r.key[1] >= 0xac00 && r.key[1] <= 0xd7a3 && !decomposable(r.key[0]);
    if (hangulCtr && !(r.key[0] === 0xfdd1 && r.key[1] === 0xac00)) throw new Error("a new Hangul-final contraction");
    if (!hangulCtr && (r.key.some(decomposable) || (r.prefix !== null && decomposable(r.prefix)))) continue;
    const ces = r.ces.map(pack);
    if (r.prefix !== null) {
      if (r.key.length !== 1) throw new Error("prefix rule with a contraction");
      if (!prefixes.has(r.key[0])) prefixes.set(r.key[0], []);
      prefixes.get(r.key[0]).push({ prev: r.prefix, ces });
    } else if (r.key.length === 1) {
      if (hanIndex.has(r.key[0])) {
        // "FA0E; [U+FA0E]": a Han character's own radical-stroke weight,
        // which the HAN stream already gives it
        if (ces.length === 1 && ces[0] === pack({ p: { han: r.key[0] }, s: [5], t: [5] })) continue;
        throw new Error(`a Han character with a weight of its own: ${r.key[0].toString(16)}`);
      }
      single.set(r.key[0], ces);
    } else {
      if (r.key.length > 3) throw new Error("contraction longer than 3");
      if (hanIndex.has(r.key[0])) throw new Error("a contraction starting with a Han character");
      if (!contractions.has(r.key[0])) contractions.set(r.key[0], []);
      contractions.get(r.key[0]).push({ rest: r.key.slice(1), ces });
    }
  }
  // (a contraction starter may have no mapping of its own — U+FDD0 / U+FDD1
  // alone take the implicit weight; its record's own entry is then 0)

  // expansion pool
  const pool = [];
  const poolIndex = new Map();
  const ref = (ces) => {
    const key = ces.join(",");
    let off = poolIndex.get(key);
    if (off === undefined) {
      off = pool.length;
      pool.push(...ces);
      poolIndex.set(key, off);
    }
    return off;
  };
  /* An entry (u32): 0 = no mapping; tag (low two bits) 1 = one CE whose P
   * fits 16 bits (entry >>> 2 is the packed CE); 2 = (off << 5 | n) << 2,
   * n CEs at POOL[off]; 3 = at << 2, a CTR record; 0 with a nonzero value
   * = (Han index + 1) << 2 (filled from the HAN stream, never in CE). */
  const entryOf = (ces) => {
    if (ces.length === 1 && ces[0] < 2 ** 30) return ces[0] * 4 + 1;
    if (ces.length > 31) throw new Error("expansion too long");
    return (ref(ces) * 32 + ces.length) * 4 + 2;
  };
  // lay the pool out in the order the streams below name its spans, so
  // that a new span's offset is (almost always) the next one
  const starters = [...new Set([...contractions.keys(), ...prefixes.keys()])].sort((a, b) => a - b);
  for (const cl of contractions.values()) {
    cl.sort((a, b) => b.rest.length - a.rest.length || a.rest[0] - b.rest[0] || (a.rest[1] ?? 0) - (b.rest[1] ?? 0));
  }
  for (const pl of prefixes.values()) pl.sort((a, b) => a.prev - b.prev);
  for (const cp of [...single.keys()].sort((a, b) => a - b)) entryOf(single.get(cp));
  for (const cp of starters) {
    if (single.has(cp)) entryOf(single.get(cp));
    for (const { ces } of prefixes.get(cp) ?? []) entryOf(ces);
    for (const { ces } of contractions.get(cp) ?? []) entryOf(ces);
  }
  const entries = new Map();
  for (const [cp, ces] of single) entries.set(cp, entryOf(ces));
  // CTR record: [own entry, nPrefix, nContraction, nPrefix x (prev, entry),
  // nContraction x (cp2, cp3 or 0, entry)], contractions longest first
  const ctr = [];
  for (const cp of starters) {
    const at = ctr.length;
    const cl = contractions.get(cp) ?? [];
    const pl = prefixes.get(cp) ?? [];
    ctr.push(entries.get(cp) ?? 0, pl.length, cl.length);
    for (const { prev, ces } of pl) ctr.push(prev, entryOf(ces));
    for (const { rest, ces } of cl) ctr.push(rest[0], rest[1] ?? 0, entryOf(ces));
    entries.set(cp, at * 4 + 3);
  }

  // ST: the distinct (secondary, tertiary) pairs of every packed CE, most
  // used first, as u s, u t; the streams below name a pair by its index
  const stUse = new Map();
  const countSt = (ce) => stUse.set(ce & 0x3fff, (stUse.get(ce & 0x3fff) ?? 0) + 1);
  for (const v of pool) countSt(v);
  for (const e of [...entries.values(), ...ctr]) if (e % 4 === 1) countSt(e >>> 2);
  const stList = [...stUse].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([st]) => st);
  const stIdx = new Map(stList.map((st, i) => [st, i]));
  const stB = new Bytes();
  for (const st of stList) {
    stB.u(st >>> 5);
    stB.u(st & 31);
  }

  /* One entry, as the CE and CTR streams spell it — u head, then:
   *   head 0                no mapping
   *   head = k*4 + 1        one CE: (s, t) = ST[k], then s (P - previous P)
   *   head = n*4 + 2        n CEs at POOL[off]: s (off - next new offset)
   *   head = at*4 + 3       a CTR record at CTR[at]
   * "previous P" and "next new offset" are per-stream state: the P of the
   * last one-CE entry, and the end of the furthest pool span named so far. */
  const entryCodec = () => ({ prevP: 0, poolNext: 0 });
  const encEntry = (B, st, e) => {
    const tag = e % 4;
    if (e === 0) B.u(0);
    else if (tag === 1) {
      const ce = e >>> 2;
      B.u(stIdx.get(ce & 0x3fff) * 4 + 1);
      B.s((ce >>> 14) - st.prevP);
      st.prevP = ce >>> 14;
    } else if (tag === 2) {
      const n = (e >>> 2) & 31;
      const off = e >>> 7;
      B.u(n * 4 + 2);
      B.s(off - st.poolNext);
      st.poolNext = Math.max(st.poolNext, off + n);
    } else if (tag === 3) B.u(e);
    else throw new Error(`entry ${e} has no stream spelling`);
  };

  // CE stream: runs over ascending code points: u gap (from the previous
  // run's end), u (len - 1), the first entry, then for a run of one-CE
  // entries s (P step) — (s, t) stay the same — and for a run of pool spans
  // nothing: each span follows the last, of the same length
  // the runtime's ASCII fast path compares two ASCII strings by one CE per
  // character: no ASCII character may expand, start a contraction or a
  // prefix rule, or be unmapped (and none decomposes or combines)
  for (let c = 0; c < 0x80; c++) {
    if ((entries.get(c) ?? 0) % 4 !== 1) throw new Error(`ASCII U+${c.toString(16)} is not one collation element`);
  }
  const cps = [...entries.keys()].sort((a, b) => a - b);
  const ce = new Bytes();
  let runs = 0;
  {
    const st = entryCodec();
    let i = 0;
    let next = 0;
    while (i < cps.length) {
      const start = cps[i];
      const v0 = entries.get(start);
      const tag = v0 % 4;
      let len = 1;
      let step = 0;
      const nextOk = (k, v) => {
        if (cps[i + k] !== start + k || v % 4 !== tag) return false;
        if (tag === 1) return ((v >>> 2) & 0x3fff) === ((v0 >>> 2) & 0x3fff) && (v >>> 16) - (v0 >>> 16) === step * k;
        if (tag === 2) {
          const n = (v0 >>> 2) & 31;
          return ((v >>> 2) & 31) === n && (v >>> 7) === (v0 >>> 7) + n * k && (v0 >>> 7) + n * k >= st.poolNext;
        }
        return false;
      };
      if (tag === 1 && i + 1 < cps.length) step = (entries.get(cps[i + 1]) >>> 16) - (v0 >>> 16);
      if (tag === 2 && (v0 >>> 7) < st.poolNext) {
        /* a reused span: a run of one */
      } else while (i + len < cps.length && nextOk(len, entries.get(cps[i + len]))) len++;
      if (len === 1) step = 0;
      ce.u(start - next);
      const ownStep = len > 1 && tag === 1 && step !== 1;
      ce.u((len - 1) * 2 + (ownStep ? 1 : 0));
      encEntry(ce, st, v0);
      if (ownStep) ce.s(step);
      if (len > 1 && tag === 1) st.prevP = (v0 >>> 16) + step * (len - 1);
      if (len > 1 && tag === 2) st.poolNext = (v0 >>> 7) + ((v0 >>> 2) & 31) * len;
      next = start + len;
      i += len;
      runs++;
    }
  }
  // HAN stream: the radical-stroke order as runs of consecutive code points,
  // each in one of the HAN_BLOCKS, read against that block's cursor (where
  // its previous run ended; at first the block's start): a byte b | len<<4
  // for a run of 1..15 at its block's cursor, else the byte b, s (start -
  // cursor), u len
  const hanB = new Bytes();
  let hanRuns = 0;
  {
    const blockOf = (c) => {
      const b = HAN_BLOCKS.findIndex(([a, z]) => c >= a && c <= z);
      if (b < 0) throw new Error(`Han character ${c.toString(16)} outside HAN_BLOCKS`);
      return b;
    };
    const cursor = HAN_BLOCKS.map(([a]) => a);
    for (let i = 0; i < han.length; ) {
      let len = 1;
      const b = blockOf(han[i]);
      while (i + len < han.length && han[i + len] === han[i] + len && blockOf(han[i + len]) === b) len++;
      const d = han[i] - cursor[b];
      if (d === 0 && len < 16) hanB.u8(b | (len << 4));
      else {
        hanB.u8(b);
        hanB.s(d);
        hanB.u(len);
      }
      cursor[b] = han[i] + len;
      i += len;
      hanRuns++;
    }
  }
  // POOL: per CE u (k*2 + (P != 0)) with (s, t) = ST[k], then when P != 0
  // s (P - the previous nonzero P)
  const poolB = new Bytes();
  {
    let prevP = 0;
    for (const v of pool) {
      const P = v >>> 14;
      poolB.u(stIdx.get(v & 0x3fff) * 2 + (P ? 1 : 0));
      if (P) {
        poolB.s(P - prevP);
        prevP = P;
      }
    }
  }
  // CTR: per record (ascending starters): u (starter - previous starter),
  // the own entry, u np, u nc, np x (s (previous character - starter), the
  // entry), nc x (s (cp2 - starter), u has-cp3, [s (cp3 - starter)], the
  // entry)
  const ctrB = new Bytes();
  const ctrStarts = [];
  {
    const st = entryCodec();
    let prevStarter = 0;
    let at = 0;
    for (const cp of starters) {
      ctrStarts.push(cp);
      const np = ctr[at + 1];
      const nc = ctr[at + 2];
      ctrB.u(cp - prevStarter);
      prevStarter = cp;
      encEntry(ctrB, st, ctr[at]);
      ctrB.u(np);
      ctrB.u(nc);
      let k = at + 3;
      for (let j = 0; j < np; j++, k += 2) {
        ctrB.s(ctr[k] - cp);
        encEntry(ctrB, st, ctr[k + 1]);
      }
      for (let j = 0; j < nc; j++, k += 3) {
        ctrB.s(ctr[k] - cp);
        ctrB.u(ctr[k + 1] === 0 ? 0 : 1);
        if (ctr[k + 1] !== 0) ctrB.s(ctr[k + 1] - cp);
        encEntry(ctrB, st, ctr[k + 2]);
      }
      if (entries.get(cp) !== at * 4 + 3) throw new Error("CTR record out of order");
      at = k;
    }
    if (at !== ctr.length) throw new Error("CTR stream incomplete");
  }
  // DECOMP: ascending code points: u gap, u (n - 1), s (first - key), then
  // n - 1 x u (index into MARKS, the distinct non-first characters, most
  // used first)
  const markUse = new Map();
  for (const d of decomp.values()) for (const x of d.slice(1)) markUse.set(x, (markUse.get(x) ?? 0) + 1);
  const marks = [...markUse].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([x]) => x);
  const markIdx = new Map(marks.map((x, i) => [x, i]));
  const decB = new Bytes();
  {
    let next = 0;
    for (const cp of [...decomp.keys()].sort((a, b) => a - b)) {
      const d = decomp.get(cp);
      if (d.length > 4) throw new Error("a decomposition longer than 4");
      decB.u((cp - next) * 4 + d.length - 1);
      decB.s(d[0] - cp);
      for (const x of d.slice(1)) decB.u(markIdx.get(x));
      next = cp + 1;
    }
  }
  const marksB = new Bytes();
  {
    let prev = 0;
    for (const x of marks) {
      marksB.s(x - prev);
      prev = x;
    }
  }
  // CCC: runs of equal class: u gap, u len, u class
  const cccB = new Bytes();
  {
    const keys = [...ccc.keys()].sort((a, b) => a - b);
    let i = 0;
    let next = 0;
    while (i < keys.length) {
      let len = 1;
      while (i + len < keys.length && keys[i + len] === keys[i] + len && ccc.get(keys[i + len]) === ccc.get(keys[i])) len++;
      cccB.u(keys[i] - next);
      cccB.u(len);
      cccB.u(ccc.get(keys[i]));
      next = keys[i] + len;
      i += len;
    }
  }
  // one blob, the streams in the order the runtime unpacks them
  const streams = [
    ["ST", stB],
    ["MARKS", marksB],
    ["CCC", cccB],
    ["DECOMP", decB],
    ["CE", ce],
    ["HAN", hanB],
    ["POOL", poolB],
    ["CTR", ctrB],
  ];
  const offsets = {};
  const sizes = {};
  const blob = [];
  for (const [name, b] of streams) {
    offsets[name] = blob.length;
    sizes[name] = b.length;
    blob.push(...b.a);
  }
  offsets.END = blob.length;
  return {
    R,
    R1,
    R2,
    commonS: secRank.get(0x0500),
    commonT: terRank.get(0x0500),
    counts: {
      ST: stList.length,
      MARKS: marks.length,
      CCC: ccc.size,
      DECOMP: decomp.size,
      CE: cps.length,
      CE_RUNS: runs,
      HAN: han.length,
      HAN_RUNS: hanRuns,
      POOL: pool.length,
      CTR: ctr.length,
      CTR_RECORDS: ctrStarts.length,
      DECOMP_LEN: [...decomp.values()].reduce((n, d) => n + d.length, 0),
      // 128-code-point blocks the runtime's two lookup tries allocate, the
      // shared all-zero block included
      CE_BLOCKS: new Set([...entries.keys(), ...han].map((c) => c >> 7)).size + 1,
      NFD_BLOCKS: new Set([...ccc.keys(), ...decomp.keys()].map((c) => c >> 7)).size + 1,
      MAX_CES: Math.max(...[...single.values(), ...[...contractions.values()].flat().map((x) => x.ces), ...[...prefixes.values()].flat().map((x) => x.ces)].map((c) => c.length)),
    },
    offsets,
    sizes,
    blob: Buffer.from(blob).toString("base64"),
  };
}

export function totalBytes(t) {
  return t.offsets.END;
}

export function render(t) {
  const c = t.counts;
  const o = t.offsets;
  const z = t.sizes;
  return `/* GENERATED by scripts/gen-wasm-collation-tables.mjs — do not edit by hand.
 * Regenerate: node scripts/gen-wasm-collation-tables.mjs
 * Drift check: packages/compiler/test/wasm-collation-tables-drift.test.ts
 *
 * ICU 78.3's root collation (its FractionalUCA.txt: CLDR 48.0, UCA 17.0.0 —
 * Node v24.18.1 ships ICU 78.3 / CLDR 48.0 / Unicode 17.0) plus Unicode 17.0
 * NFD data, for String.prototype.localeCompare (collation.ts): ${o.END} bytes,
 * one blob of eight streams. Rows whose key holds a canonically decomposable
 * character are dropped (the runtime collates the NFD form). Derived from
 * Unicode data files: © Unicode, Inc., under the Unicode License v3
 * (https://www.unicode.org/license.txt).
 *
 * Weights are dense ranks (the generator's header says how). A packed
 * collation element (u32) is P << 14 | s << 5 | t: P is 0 (ignorable), a
 * primary rank 1..COLL_R (COLL_R1 / COLL_R2 say where Han and the implicit
 * weights fall among them) or COLL_R + 1 + a Han index; s a secondary rank
 * (0 = ignorable); t a tertiary rank, case bits masked off (0 = ignorable).
 * An ENTRY (u32), what a code point maps to: 0 no mapping (the implicit
 * weight); ce*4 + 1 one packed CE whose P < 2^16; (off*32 + n)*4 + 2 n packed
 * CEs at POOL[off]; at*4 + 3 a CTR record at CTR[at]; (k + 1)*4 the k-th Han
 * character in radical-stroke order.
 *
 * Streams, of LEB128 varints ("u") and zigzag varints of 32-bit values ("s",
 * added modulo 2^32):
 *   ST      ${c.ST} (secondary, tertiary) rank pairs, most used first: u s, u t
 *   MARKS   ${c.MARKS} non-first decomposition characters, most used first:
 *           s (cp - previous)
 *   CCC     nonzero Canonical_Combining_Class runs: u gap (from the previous
 *           run's end), u len, u class
 *   DECOMP  ${c.DECOMP} full canonical decompositions (Hangul is algorithmic),
 *           ascending: u (gap*4 + n - 1), the gap from the previous key + 1,
 *           s (first - key), n - 1 x u (index into MARKS)
 *   CE      ${c.CE} code points' entries in ${c.CE_RUNS} runs: u gap (from the
 *           previous run's end), u ((len - 1)*2 + own step), the first entry,
 *           then for a run of one-CE entries s (P step) if it has its own
 *           step, else the step is 1 (s and t stay); for a run of pool spans
 *           nothing (each span follows the last, of the same length).
 *           An entry is u head, then: head 0, no mapping; k*4 + 1, one CE with
 *           (s, t) = ST[k], then s (P - the stream's previous one-CE P); n*4 +
 *           2, n CEs at POOL[off], then s (off - the end of the furthest span
 *           named so far); at*4 + 3, the CTR record at CTR[at]
 *   HAN     ${c.HAN} Han characters in radical-stroke order (${c.HAN_RUNS} runs of
 *           consecutive code points), each run in one of COLL_HAN_BLOCKS and
 *           read against that block's cursor (where its last run ended, at
 *           first its start): a byte b | len << 4 for 1..15 characters at the
 *           cursor, else the byte b, s (start - cursor), u len
 *   POOL    ${c.POOL} packed CEs: u (k*2 + (P != 0)) with (s, t) = ST[k], then
 *           when P != 0 s (P - the previous nonzero P)
 *   CTR     ${c.CTR_RECORDS} records (${c.CTR} values unpacked) by ascending starter:
 *           u (starter - previous starter), the own entry, u np, u nc; np x
 *           (s (preceding character - starter), entry); nc x (s (cp2 -
 *           starter), u has-cp3, [s (cp3 - starter)], entry), longest first.
 *           Unpacked: [own entry, np, nc, np x (prev, entry), nc x (cp2, cp3
 *           or 0, entry)]
 */

export const COLL_DATA = "${t.blob}";

/** Stream offsets into COLL_DATA (sizes: ${Object.entries(z).map(([k, v]) => `${k} ${v}`).join(", ")}). */
${Object.entries(o).map(([k, v]) => `export const COLL_OFF_${k} = ${v};`).join("\n")}

export const COLL_ST_COUNT = ${c.ST};
export const COLL_MARKS_COUNT = ${c.MARKS};
export const COLL_DECOMP_COUNT = ${c.DECOMP};
export const COLL_HAN_COUNT = ${c.HAN};
export const COLL_POOL_LEN = ${c.POOL};
export const COLL_CTR_LEN = ${c.CTR};
export const COLL_CTR_RECORDS = ${c.CTR_RECORDS};
/** Code points in all decompositions together. */
export const COLL_DECOMP_LEN = ${c.DECOMP_LEN};
/** 128-code-point blocks of the CE and NFD lookup tries, the shared
 * all-zero block included. */
export const COLL_CE_BLOCKS = ${c.CE_BLOCKS};
export const COLL_NFD_BLOCKS = ${c.NFD_BLOCKS};
/** The one contraction ending in a Hangul syllable, U+FDD1 U+AC00: the
 * runtime keeps a U+AC00 that directly follows U+FDD1 whole. */
export const COLL_HANGUL_CTR: readonly [number, number] = [0xfdd1, 0xac00];
/** The most collation elements one mapping has. */
export const COLL_MAX_CES = ${c.MAX_CES};

/** Explicit primary ranks: 1..COLL_R1 sort below Han, COLL_R1+1..COLL_R2
 * between Han and the implicit weights, COLL_R2+1..COLL_R above them. */
export const COLL_R = ${t.R};
export const COLL_R1 = ${t.R1};
export const COLL_R2 = ${t.R2};

/** The ranks of the common secondary and tertiary weights (05): what a Han
 * character and an implicit weight carry. */
export const COLL_COMMON_S = ${t.commonS};
export const COLL_COMMON_T = ${t.commonT};

/** First code points of the HAN stream's blocks (their cursors' start). */
export const COLL_HAN_BLOCKS: readonly number[] = [${HAN_BLOCKS.map(([a]) => "0x" + a.toString(16)).join(", ")}];

export function collDataBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(COLL_DATA, "base64"));
}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = build(process.argv[2] ?? DEFAULT_SOURCE_DIR);
  writeFileSync(OUT_PATH, render(t));
  console.log(`wrote ${OUT_PATH} (${totalBytes(t)} bytes of data: ${JSON.stringify(t.sizes)})`);
}
