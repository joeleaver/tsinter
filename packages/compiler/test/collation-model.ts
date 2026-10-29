/* A JavaScript model of backend/wasm/collation.ts over the checked-in
 * collation-tables.ts: the same unpack, the same NFD, the same CE
 * generation and the same level-by-level comparison, step for step. It
 * exists so the tables can be held to Node's ICU over every code point
 * (and millions of strings) in seconds, without compiling a program per
 * check; test/wasm-collation.test.ts runs it against Intl.Collator and
 * runs compiled programs against Node on the wasm and wasm-native lanes. */
import {
  COLL_COMMON_S,
  COLL_COMMON_T,
  COLL_CTR_RECORDS,
  COLL_HAN_BLOCKS,
  COLL_HANGUL_CTR,
  COLL_MARKS_COUNT,
  COLL_OFF_CE,
  COLL_OFF_DECOMP,
  COLL_OFF_END,
  COLL_OFF_HAN,
  COLL_OFF_POOL,
  COLL_POOL_LEN,
  COLL_R,
  COLL_R1,
  COLL_R2,
  COLL_ST_COUNT,
  collDataBytes,
} from "../src/backend/wasm/collation-tables.js";

interface Tables {
  entries: Map<number, number>;
  pool: number[];
  ctr: number[];
  decomp: Map<number, number[]>;
  ccc: Map<number, number>;
}

let memo: Tables | null = null;

export function collationTables(): Tables {
  if (memo !== null) return memo;
  const b = collDataBytes();
  let pos = 0;
  const u = (): number => {
    let v = 0;
    let sh = 0;
    let x: number;
    do {
      x = b[pos++]!;
      v = (v | ((x & 0x7f) << sh)) >>> 0;
      sh += 7;
    } while (x & 0x80);
    return v;
  };
  const s = (): number => {
    const z = u();
    return ((z >>> 1) ^ -(z & 1)) | 0;
  };
  const st: number[] = [];
  for (let k = 0; k < COLL_ST_COUNT; k++) {
    const sv = u();
    st.push((sv << 5) | u());
  }
  const marks: number[] = [];
  for (let k = 0, p = 0; k < COLL_MARKS_COUNT; k++) marks.push((p = (p + s()) | 0));
  const ccc = new Map<number, number>();
  for (let next = 0; pos < COLL_OFF_DECOMP; ) {
    const start = next + u();
    const len = u();
    const c = u();
    for (let k = 0; k < len; k++) ccc.set(start + k, c);
    next = start + len;
  }
  const decomp = new Map<number, number[]>();
  for (let next = 0; pos < COLL_OFF_CE; ) {
    const h = u();
    const cp = next + (h >>> 2);
    const d = [cp + s()];
    for (let k = 1; k <= (h & 3); k++) d.push(marks[u()]!);
    decomp.set(cp, d);
    next = cp + 1;
  }
  const entries = new Map<number, number>();
  const codec = { prevP: 0, poolNext: 0 };
  const readEntry = (): number => {
    const h = u();
    if (h === 0) return 0;
    if ((h & 3) === 1) {
      codec.prevP = (codec.prevP + s()) | 0;
      return ((codec.prevP << 16) | (st[h >>> 2]! << 2) | 1) >>> 0;
    }
    if ((h & 3) === 2) {
      const n = h >>> 2;
      const off = (codec.poolNext + s()) | 0;
      codec.poolNext = Math.max(codec.poolNext, off + n);
      return ((off << 7) | (n << 2) | 2) >>> 0;
    }
    return h;
  };
  for (let next = 0; pos < COLL_OFF_HAN; ) {
    const start = next + u();
    const lf = u();
    const len = (lf >>> 1) + 1;
    const e = readEntry();
    if ((e & 3) === 1) {
      const step = len > 1 ? (lf & 1 ? s() : 1) : 0;
      for (let k = 0; k < len; k++) entries.set(start + k, (e + ((k * step) << 16)) >>> 0);
      codec.prevP = (e >>> 16) + step * (len - 1);
    } else if ((e & 3) === 2) {
      const n = (e >>> 2) & 31;
      for (let k = 0; k < len; k++) entries.set(start + k, (e + ((k * n) << 7)) >>> 0);
      codec.poolNext = Math.max(codec.poolNext, (e >>> 7) + n * len);
    } else entries.set(start, e);
    next = start + len;
  }
  {
    const cur = [...COLL_HAN_BLOCKS];
    let k = 0;
    while (pos < COLL_OFF_POOL) {
      const x = b[pos++]!;
      const bl = x & 15;
      let start: number;
      let len: number;
      if (x >> 4) {
        start = cur[bl]!;
        len = x >> 4;
      } else {
        start = cur[bl]! + s();
        len = u();
      }
      for (let j = 0; j < len; j++) entries.set(start + j, ++k * 4);
      cur[bl] = start + len;
    }
  }
  const pool: number[] = [];
  for (let k = 0, p = 0; k < COLL_POOL_LEN; k++) {
    const h = u();
    let P = 0;
    if (h & 1) P = p = (p + s()) | 0;
    pool.push(((P << 14) | st[h >>> 1]!) >>> 0);
  }
  const ctr: number[] = [];
  codec.prevP = 0;
  codec.poolNext = 0;
  for (let r = 0, starter = 0; r < COLL_CTR_RECORDS; r++) {
    starter += u();
    const own = readEntry();
    const np = u();
    const nc = u();
    ctr.push(own, np, nc);
    for (let j = 0; j < np; j++) {
      const prev = starter + s();
      ctr.push(prev, readEntry());
    }
    for (let j = 0; j < nc; j++) {
      const c2 = starter + s();
      const c3 = u() ? starter + s() : 0;
      ctr.push(c2, c3, readEntry());
    }
  }
  if (pos !== COLL_OFF_END) throw new Error(`collation data: ${COLL_OFF_END - pos} bytes left over`);
  memo = { entries, pool, ctr, decomp, ccc };
  return memo;
}

/** [primary, secondary, tertiary] per collation element */
export type CE = [number, number, number];

const prim = (P: number): number =>
  P === 0 ? 0 : P <= COLL_R1 ? P : P <= COLL_R2 ? 0x70000 + P : P <= COLL_R ? 0x200000 + P : 0x40000 + (P - COLL_R - 1);

/** The routine stops by name here (collation.ts STOP_MESSAGE): ICU's
 * answer depends on iterator state this routine does not model. */
export class CollationStop extends Error {}

/** Whether a CTR record has a contraction whose last character is a
 * non-starter (ICU's CONTRACT_TRAILING_CCC: discontiguous matching may
 * follow it). */
function ctrTrailing(D: Tables, at: number): boolean {
  const np = D.ctr[at + 1]!;
  const nc = D.ctr[at + 2]!;
  const cb = at + 3 + 2 * np;
  for (let k = 0; k < nc; k++) {
    const last = D.ctr[cb + 3 * k + 1] || D.ctr[cb + 3 * k]!;
    if ((D.ccc.get(last) ?? 0) !== 0) return true;
  }
  return false;
}

export function collationElements(str: string, asDelivered = false): CE[] {
  const D = collationTables();
  const cccOf = (c: number): number => D.ccc.get(c) ?? 0;
  const cps: number[] = [];
  // the raw code points, where each one's decomposition starts in cps, and
  // its lead ccc (for the supplementary-mark quirk below)
  const raw: number[] = [];
  const rawAt: number[] = [];
  for (let i = 0; i < str.length; i++) {
    rawAt.push(cps.length);
    let c = str.charCodeAt(i);
    if ((c & 0xfc00) === 0xd800 && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if ((d & 0xfc00) === 0xdc00) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    raw.push(c);
    if (c === COLL_HANGUL_CTR[1] && cps[cps.length - 1] === COLL_HANGUL_CTR[0]) {
      cps.push(c); // the contraction U+FDD1 U+AC00 matches the syllable itself
      continue;
    }
    if (c >= 0xac00 && c <= 0xd7a3) {
      const si = c - 0xac00;
      cps.push(0x1100 + Math.floor(si / 588), 0x1161 + Math.floor((si % 588) / 28));
      if (si % 28) cps.push(0x11a7 + (si % 28));
      continue;
    }
    cps.push(...(D.decomp.get(c) ?? [c]));
  }
  rawAt.push(cps.length);
  /* ICU's supplementary-mark quirk (collation.ts markQuirks). For each
   * maximal run R of raw non-starters after a raw code point P (or the
   * start): R out of canonical order whose last two raw code points are a
   * supplementary mark and a BMP mark (not a possible Tibetan composite
   * vowel). If P starts trailing contractions and R holds no contraction
   * starter, the run is re-read raw-last when P matches nothing (`quirk`,
   * by P's cps index) and P matching something stops by name; a
   * contraction starter inside R stops by name. */
  const quirk = new Map<number, number[]>();
  const stopAt = new Set<number>();
  const isCtrStarter = (c: number): boolean => ((D.entries.get(c) ?? 0) & 3) === 3 && D.ctr[((D.entries.get(c) ?? 0) >>> 2) + 2]! > 0;
  for (let r = -1; r + 2 < raw.length; r++) {
    if (r >= 0 && cccOf(cps[rawAt[r]!]!) !== 0) continue;
    let m = r + 1;
    while (m < raw.length && cccOf(cps[rawAt[m]!]!) !== 0) m++;
    const last = m - 1;
    if (last - (r + 1) < 1 || raw[last]! > 0xffff || raw[last - 1]! <= 0xffff) continue;
    // ICU checks the segment anyway before a possible Tibetan composite
    // vowel (CollationFCD::maybeTibetanCompositeVowel: odd U+0F01..U+0FFF)
    if ((raw[last]! & 0x1fff01) === 0xf01) continue;
    const run = cps.slice(rawAt[r + 1]!, rawAt[m]!);
    if (run.every((x, k) => k === 0 || cccOf(run[k - 1]!) <= cccOf(x))) continue; // already canonical
    if (run.some(isCtrStarter)) {
      stopAt.add(r);
      continue;
    }
    if (r < 0) continue;
    const e = D.entries.get(raw[r]!) ?? 0;
    if ((e & 3) !== 3 || !ctrTrailing(D, e >>> 2) || rawAt[r + 1]! - rawAt[r]! !== 1) continue;
    const head = cps.slice(rawAt[r + 1]!, rawAt[last]!);
    const headCc = head.map(cccOf);
    // stable canonical sort of the head; the last mark's decomposition after it
    const idx = head.map((_, k) => k).sort((a, b) => headCc[a]! - headCc[b]! || a - b);
    quirk.set(rawAt[r]!, [...idx.map((k) => head[k]!), ...cps.slice(rawAt[last]!, rawAt[m]!)]);
  }
  if (stopAt.size > 0) throw new CollationStop();
  const cc = cps.map(cccOf);
  for (let i = 1; i < (asDelivered ? 0 : cps.length); i++) {
    const x = cc[i]!;
    if (!x) continue;
    const cur = cps[i]!;
    let j = i;
    while (j > 0 && cc[j - 1]! > x) {
      cps[j] = cps[j - 1]!;
      cc[j] = cc[j - 1]!;
      j--;
    }
    cps[j] = cur;
    cc[j] = x;
  }
  const out: CE[] = [];
  const pushPacked = (ce: number): void => {
    out.push([prim(ce >>> 14), (ce >>> 5) & 0x1ff, ce & 31]);
  };
  const pushEntry = (e: number, c: number): void => {
    if (e === 0) out.push([0x80000 + c, COLL_COMMON_S, COLL_COMMON_T]);
    else if ((e & 3) === 0) out.push([0x40000 + (e >>> 2) - 1, COLL_COMMON_S, COLL_COMMON_T]);
    else if ((e & 3) === 1) pushPacked(e >>> 2);
    else for (let k = 0; k < ((e >>> 2) & 31); k++) pushPacked(D.pool[(e >>> 7) + k]!);
  };
  for (let i = 0; i < cps.length; i++) {
    if (cc[i] === -1) continue;
    const c = cps[i]!;
    const e = D.entries.get(c) ?? 0;
    if ((e & 3) !== 3) {
      pushEntry(e, c);
      continue;
    }
    const at = e >>> 2;
    let best = D.ctr[at]!;
    const np = D.ctr[at + 1]!;
    const nc = D.ctr[at + 2]!;
    if (i > 0) {
      for (let k = 0; k < np; k++) {
        if (D.ctr[at + 3 + 2 * k] === cps[i - 1]) {
          best = D.ctr[at + 4 + 2 * k]!;
          break;
        }
      }
    }
    const cb = at + 3 + 2 * np;
    let mlen = 1;
    let m2 = -1;
    let end = i;
    const j1 = i + 1;
    if (j1 < cps.length && cc[j1] !== -1) {
      for (let k = 0; k < nc; k++) {
        const c2 = D.ctr[cb + 3 * k]!;
        const c3 = D.ctr[cb + 3 * k + 1]!;
        if (cps[j1] !== c2) continue;
        if (c3 !== 0) {
          if (j1 + 1 < cps.length && cc[j1 + 1] !== -1 && cps[j1 + 1] === c3) {
            best = D.ctr[cb + 3 * k + 2]!;
            mlen = 3;
            end = j1 + 1;
            break;
          }
        } else {
          best = D.ctr[cb + 3 * k + 2]!;
          mlen = 2;
          m2 = c2;
          end = j1;
          break;
        }
      }
    }
    for (let j = i + 1; j <= end; j++) cc[j] = -1;
    if (mlen < 3 && nc) {
      let last = -1;
      for (let j = end + 1; j < cps.length && mlen < 3; j++) {
        const x = cc[j]!;
        if (x === -1) continue;
        if (x === 0) break;
        let hit = -1;
        if (last === -1 || last < x) {
          for (let k = 0; k < nc; k++) {
            const c2 = D.ctr[cb + 3 * k]!;
            const c3 = D.ctr[cb + 3 * k + 1]!;
            if (mlen === 1 ? c2 === cps[j] && c3 === 0 : c2 === m2 && c3 === cps[j]) {
              hit = D.ctr[cb + 3 * k + 2]!;
              break;
            }
          }
        }
        if (hit !== -1) {
          best = hit;
          if (mlen === 1) m2 = cps[j]!;
          mlen++;
          cc[j] = -1;
        } else last = x;
      }
    }
    if (mlen > 1 && quirk.has(i)) throw new CollationStop();
    const q = mlen === 1 ? quirk.get(i) : undefined;
    if (q !== undefined) {
      q.forEach((x, k) => {
        cps[i + 1 + k] = x;
        cc[i + 1 + k] = cccOf(x);
      });
    }
    pushEntry(best, c);
  }
  return out;
}

export function modelCompare(a: string, b: string): -1 | 0 | 1 {
  return compareCEs(collationElements(a), collationElements(b));
}

/** Level-by-level comparison of two CE sequences. */
export function compareCEs(x: CE[], y: CE[]): -1 | 0 | 1 {
  for (let lv = 0; lv < 3; lv++) {
    let i = 0;
    let j = 0;
    for (;;) {
      while (i < x.length && x[i]![lv] === 0) i++;
      while (j < y.length && y[j]![lv] === 0) j++;
      if (i >= x.length || j >= y.length) {
        if (i < x.length) return 1;
        if (j < y.length) return -1;
        break;
      }
      const p = x[i]![lv]!;
      const q = y[j]![lv]!;
      if (p !== q) return p < q ? -1 : 1;
      i++;
      j++;
    }
  }
  return 0;
}
