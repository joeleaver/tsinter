/* zlib.deflateSync / zlib.inflateSync on the WasmGC tier: a port of the
 * zlib Node v24.18.1 bundles (process.versions.zlib "1.3.1-e00f703":
 * Chromium's zlib fork at revision e00f703, deps/zlib in Node's tree),
 * built the way Node's scalar path computes it, so this tier's deflate
 * bytes are Node's bytes and its inflate fails where Node's fails, with
 * Node's message and code.
 *
 *   - Deflate: deflate.c (deflateInit2_ with Node's defaults — windowBits
 *     15, memLevel 8, Z_DEFAULT_STRATEGY — deflateReset, lm_init,
 *     fill_window, read_buf, slide_hash, longest_match's byte-compare
 *     path, deflate_stored / deflate_fast / deflate_slow under the
 *     configuration table, flush_pending, deflate()'s zlib header and
 *     adler32 trailer) with Chromium's changes: the multiplicative
 *     insert_string hash of contrib/optimizations/insert_string.h
 *     (hash_bits forced to 15), its four-byte fill_window insert rule,
 *     the zeroed WINDOW_PADDING window, and LIT_MEM's split d_buf/l_buf.
 *     trees.c entire (the static tables as tr_static_init computes them,
 *     init_block, pqdownheap, gen_bitlen, gen_codes, build_tree,
 *     scan_tree, send_tree, build_bl_tree, send_all_trees,
 *     compress_block, _tr_stored_block, _tr_flush_block, the 16-bit
 *     bit buffer). detect_data_type is left out: it only sets
 *     strm->data_type, which nothing here reads.
 *   - The driver is Node's processChunkSync: deflate(Z_FINISH) called
 *     with a fresh 16 KiB of avail_out for as long as a call fills it
 *     (deflate_stored sizes its blocks from avail_out, so level 0 needs
 *     the same chunks; levels 1-9 do not depend on them).
 *   - Inflate: inflate.c's state machine for a zlib stream (wrap 5,
 *     wbits 15: no gzip header), inftrees.c's inflate_table, and the
 *     fixed tables built as BUILDFIXED builds them. The stream is
 *     inflated in one call into an output that grows as needed, so the
 *     output is its own window: a distance past everything written is
 *     "invalid distance too far back", as zlib's window check answers.
 *     inflate_fast is not ported — it decodes the same codes with the
 *     same checks and only runs while at least 6 input bytes remain, so
 *     the slow path reaches the same output and the same error at the
 *     same point. Node's classification follows: Z_STREAM_END is
 *     success (bytes after the stream are ignored), Z_DATA_ERROR
 *     carries zlib's message, Z_NEED_DICT is "Missing dictionary", and
 *     running out of input is "unexpected end of file" (Z_BUF_ERROR).
 *
 * Everything lives in a linear-memory work area at the staging cursor
 * (aligned), grown once per call; the scalar state is module globals.
 * Input and output are GC byte arrays.
 *
 * zlib (C) 1995-2024 Jean-loup Gailly and Mark Adler, used under the
 * zlib license; Chromium's additions (C) The Chromium Authors, BSD-style.
 *
 * SEMANTICS.md S101 registers where this tier and Node part. */
import { A, Fn, type X } from "./asm.js";
import type { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export interface ZlibDeps {
  /** array (mut i8) — a Buffer's storage. */
  bufType: () => number;
  /** struct (buf, off, len) — a bytes<u8> view. */
  bytesType: () => number;
  /** Grow linear memory so `need` bytes fit past the staging cursor. */
  ensureCapacity: (c: Code, need: () => void) => void;
  stageCursor: () => number;
}

/** inflateSync's failures (the error global): id, Node's message, code.
 * 1-15 are zlib's strm->msg (Z_DATA_ERROR, errno -3); then Z_NEED_DICT
 * (errno 2) and Node's end-of-input text (Z_BUF_ERROR, errno -5). */
export const ZLIB_ERRORS: readonly (readonly [number, string, string])[] = [
  [1, "incorrect header check", "Z_DATA_ERROR"],
  [2, "unknown compression method", "Z_DATA_ERROR"],
  [3, "invalid window size", "Z_DATA_ERROR"],
  [4, "invalid block type", "Z_DATA_ERROR"],
  [5, "invalid stored block lengths", "Z_DATA_ERROR"],
  [6, "too many length or distance symbols", "Z_DATA_ERROR"],
  [7, "invalid code lengths set", "Z_DATA_ERROR"],
  [8, "invalid bit length repeat", "Z_DATA_ERROR"],
  [9, "invalid code -- missing end-of-block", "Z_DATA_ERROR"],
  [10, "invalid literal/lengths set", "Z_DATA_ERROR"],
  [11, "invalid distances set", "Z_DATA_ERROR"],
  [12, "invalid literal/length code", "Z_DATA_ERROR"],
  [13, "invalid distance code", "Z_DATA_ERROR"],
  [14, "invalid distance too far back", "Z_DATA_ERROR"],
  [15, "incorrect data check", "Z_DATA_ERROR"],
  [16, "Missing dictionary", "Z_NEED_DICT"],
  [17, "unexpected end of file", "Z_BUF_ERROR"],
];
const E = {
  HEADER: 1, METHOD: 2, WSIZE: 3, BTYPE: 4, STORED: 5, NSYMS: 6, CLSET: 7, REPEAT: 8, NOEOB: 9, LLSET: 10, DSET: 11,
  LLCODE: 12, DCODE: 13, FAR: 14, CHECK: 15, DICT: 16, EOF: 17,
} as const;

/* ── deflate's constants (deflate.h, Node's defaults) ─────────────────── */
const W_SIZE = 32768;
const W_MASK = W_SIZE - 1;
const WINDOW_SIZE = 2 * W_SIZE;
const WINDOW_PADDING = 8;
const HASH_SIZE = 32768; // memLevel 8 + 7 = 15 bits (Chromium's minimum too)
const HASH_MASK = HASH_SIZE - 1;
const LIT_BUFSIZE = 16384; // 1 << (memLevel + 6)
const PENDING_BUF_SIZE = LIT_BUFSIZE * 4;
const SYM_END = LIT_BUFSIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const MAX_DIST = W_SIZE - MIN_LOOKAHEAD;
const WIN_INIT = MAX_MATCH;
const TOO_FAR = 4096;
const L_CODES = 286;
const D_CODES = 30;
const BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1;
const END_BLOCK = 256;
const LITERALS = 256;
const MAX_BL_BITS = 7;
const MAX_BITS = 15;
const Z_NO_FLUSH = 0;
const Z_FINISH = 4;
const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_BUF_ERROR = -5;
const Z_FIXED = 4;
const INIT_STATE = 42;
const BUSY_STATE = 113;
const FINISH_STATE = 666;
/** block_state */
const NEED_MORE = 0;
const FINISH_STARTED = 2;
const FINISH_DONE = 3;
/** Node's Z_DEFAULT_CHUNK. */
const CHUNK = 16384;

/* ── trees.c's static tables, as tr_static_init computes them ─────────── */
const EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** deflate.c's configuration_table: good, lazy, nice, chain per level. */
const CONFIG = [
  [0, 0, 0, 0], [4, 4, 8, 4], [4, 5, 16, 8], [4, 6, 32, 32], [4, 4, 16, 16],
  [8, 16, 32, 32], [8, 16, 128, 128], [8, 32, 128, 256], [32, 128, 258, 1024], [32, 258, 258, 4096],
];

function biReverse(code: number, len: number): number {
  let res = 0;
  do {
    res |= code & 1;
    code >>>= 1;
    res <<= 1;
  } while (--len > 0);
  return res >>> 1;
}

interface TreeTables {
  ltreeCode: number[];
  ltreeLen: number[];
  dtreeCode: number[];
  distCode: number[];
  lengthCode: number[];
  baseLength: number[];
  baseDist: number[];
}

/** tr_static_init (with GEN_TREES_H's computation, which trees.h prints). */
export function treeTables(): TreeTables {
  const lengthCode: number[] = new Array<number>(256).fill(0);
  const baseLength: number[] = new Array<number>(29).fill(0);
  const distCode: number[] = new Array<number>(512).fill(0);
  const baseDist: number[] = new Array<number>(30).fill(0);
  let length = 0;
  let code: number;
  for (code = 0; code < 28; code++) {
    baseLength[code] = length;
    for (let n = 0; n < 1 << EXTRA_LBITS[code]!; n++) lengthCode[length++] = code;
  }
  lengthCode[length - 1] = code;
  let dist = 0;
  for (code = 0; code < 16; code++) {
    baseDist[code] = dist;
    for (let n = 0; n < 1 << EXTRA_DBITS[code]!; n++) distCode[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    baseDist[code] = dist << 7;
    for (let n = 0; n < 1 << (EXTRA_DBITS[code]! - 7); n++) distCode[256 + dist++] = code;
  }
  const blCount = new Array<number>(MAX_BITS + 1).fill(0);
  const ltreeLen = new Array<number>(L_CODES + 2).fill(0);
  let n = 0;
  for (; n <= 143; n++) {
    ltreeLen[n] = 8;
    blCount[8] = blCount[8]! + 1;
  }
  for (; n <= 255; n++) {
    ltreeLen[n] = 9;
    blCount[9] = blCount[9]! + 1;
  }
  for (; n <= 279; n++) {
    ltreeLen[n] = 7;
    blCount[7] = blCount[7]! + 1;
  }
  for (; n <= 287; n++) {
    ltreeLen[n] = 8;
    blCount[8] = blCount[8]! + 1;
  }
  // gen_codes(static_ltree, L_CODES + 1, bl_count)
  const nextCode = new Array<number>(MAX_BITS + 1).fill(0);
  let c = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    c = (c + blCount[bits - 1]!) << 1;
    nextCode[bits] = c & 0xffff;
  }
  const ltreeCode = new Array<number>(L_CODES + 2).fill(0);
  for (n = 0; n <= L_CODES + 1; n++) {
    const len = ltreeLen[n]!;
    if (len === 0) continue;
    ltreeCode[n] = biReverse(nextCode[len]!, len);
    nextCode[len] = (nextCode[len]! + 1) & 0xffff;
  }
  const dtreeCode: number[] = [];
  for (n = 0; n < D_CODES; n++) dtreeCode.push(biReverse(n, 5));
  return { ltreeCode, ltreeLen, dtreeCode, distCode, lengthCode, baseLength, baseDist };
}

/* ── the work area ─────────────────────────────────────────────────────── */

/** A region allocator: offsets inside the work area, 4-aligned. */
function layout(sizes: Record<string, number>): { off: Record<string, number>; total: number } {
  const off: Record<string, number> = {};
  let p = 0;
  for (const [k, n] of Object.entries(sizes)) {
    off[k] = p;
    p += (n + 3) & ~3;
  }
  return { off, total: p };
}

/** Deflate's regions. Static tables (blob-initialized) come last. */
const DL = layout({
  WIN: (W_SIZE + WINDOW_PADDING) * 2,
  PREV: W_SIZE * 2,
  HEAD: HASH_SIZE * 2,
  PEND: LIT_BUFSIZE * 5,
  LTREE: HEAP_SIZE * 4,
  DTREE: (2 * D_CODES + 1) * 4,
  BLTREE: (2 * BL_CODES + 1) * 4,
  BLCOUNT: (MAX_BITS + 1) * 2,
  NEXTCODE: (MAX_BITS + 1) * 2,
  HEAP: HEAP_SIZE * 4,
  DEPTH: HEAP_SIZE,
  // the static blob, in this order
  SLTREE: (L_CODES + 2) * 4,
  SDTREE: D_CODES * 4,
  DISTCODE: 512,
  LENCODE: 256,
  BASELEN: 29 * 4,
  BASEDIST: 30 * 4,
  XLBITS: 29 * 4,
  XDBITS: 30 * 4,
  XBLBITS: 19 * 4,
  BLORDER: 19,
  CONFIG: 10 * 8,
});
const D = DL.off as Record<
  | "WIN" | "PREV" | "HEAD" | "PEND" | "LTREE" | "DTREE" | "BLTREE" | "BLCOUNT" | "NEXTCODE" | "HEAP" | "DEPTH"
  | "SLTREE" | "SDTREE" | "DISTCODE" | "LENCODE" | "BASELEN" | "BASEDIST" | "XLBITS" | "XDBITS" | "XBLBITS" | "BLORDER" | "CONFIG",
  number
>;
const D_BUF = D.PEND + (LIT_BUFSIZE << 1);
const L_BUF = D.PEND + (LIT_BUFSIZE << 2);

/** Inflate's regions (the same area; one call runs at a time). */
const IL = layout({
  LENS: 320 * 2,
  WORK: 288 * 2,
  CODES: 1924 * 4, // ENOUGH
  FIXED: 544 * 4,
  FLENS: 320 * 2,
  COUNT: 16 * 2,
  OFFS: 16 * 2,
  // the static blob
  ORDER: 19 * 2,
  LBASE: 31 * 2,
  LEXT: 31 * 2,
  DBASE: 32 * 2,
  DEXT: 32 * 2,
});
const I = IL.off as Record<"LENS" | "WORK" | "CODES" | "FIXED" | "FLENS" | "COUNT" | "OFFS" | "ORDER" | "LBASE" | "LEXT" | "DBASE" | "DEXT", number>;
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0];
const LEXT = [16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 203, 77];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0];
const DEXT = [16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64];
const ENOUGH_LENS = 1332;
const ENOUGH_DISTS = 592;
const CODES = 0;
const LENS = 1;
const DISTS = 2;

/** The work area's size: the larger of the two layouts. */
const AREA = Math.max(DL.total, IL.total);

/** The deflate blob: SLTREE .. CONFIG as laid out above. */
function deflateBlob(): Uint8Array {
  const t = treeTables();
  const base = D.SLTREE;
  const out = new Uint8Array(DL.total - base);
  const v = new DataView(out.buffer);
  for (let n = 0; n < L_CODES + 2; n++) {
    v.setUint16(D.SLTREE - base + n * 4, t.ltreeCode[n]!, true);
    v.setUint16(D.SLTREE - base + n * 4 + 2, t.ltreeLen[n]!, true);
  }
  for (let n = 0; n < D_CODES; n++) {
    v.setUint16(D.SDTREE - base + n * 4, t.dtreeCode[n]!, true);
    v.setUint16(D.SDTREE - base + n * 4 + 2, 5, true);
  }
  t.distCode.forEach((x, i) => v.setUint8(D.DISTCODE - base + i, x));
  t.lengthCode.forEach((x, i) => v.setUint8(D.LENCODE - base + i, x));
  t.baseLength.forEach((x, i) => v.setInt32(D.BASELEN - base + i * 4, x, true));
  t.baseDist.forEach((x, i) => v.setInt32(D.BASEDIST - base + i * 4, x, true));
  EXTRA_LBITS.forEach((x, i) => v.setInt32(D.XLBITS - base + i * 4, x, true));
  EXTRA_DBITS.forEach((x, i) => v.setInt32(D.XDBITS - base + i * 4, x, true));
  EXTRA_BLBITS.forEach((x, i) => v.setInt32(D.XBLBITS - base + i * 4, x, true));
  BL_ORDER.forEach((x, i) => v.setUint8(D.BLORDER - base + i, x));
  CONFIG.forEach((row, lv) => row.forEach((x, j) => v.setUint16(D.CONFIG - base + lv * 8 + j * 2, x, true)));
  return out;
}

function inflateBlob(): Uint8Array {
  const base = I.ORDER;
  const out = new Uint8Array(IL.total - base);
  const v = new DataView(out.buffer);
  const put = (off: number, xs: number[]): void => xs.forEach((x, i) => v.setUint16(off - base + i * 2, x, true));
  put(I.ORDER, BL_ORDER);
  put(I.LBASE, LBASE);
  put(I.LEXT, LEXT);
  put(I.DBASE, DBASE);
  put(I.DEXT, DEXT);
  return out;
}

/* ── a function under construction: the DSL plus labelled control flow
 *    and work-area access ─────────────────────────────────────────────── */

type Label = object;

class K {
  readonly c: Code;
  private readonly frames: Label[] = [];
  constructor(
    readonly f: Fn,
    readonly $: A,
    private readonly zb: number,
    private readonly gl: (name: string) => number,
  ) {
    this.c = f.c;
  }

  i(n: number): X {
    return this.$.i(n);
  }
  l(n: number): X {
    return this.$.l(n);
  }
  local(t: ValType = I32): number {
    return this.f.local(t);
  }
  put(local: number, v: X): void {
    this.$.put(local, v);
  }
  G(name: string): X {
    return this.$.g(this.gl(name));
  }
  S(name: string, v: X): void {
    this.$.gput(this.gl(name), v);
  }
  /** name += n */
  inc(name: string, v: X): void {
    this.S(name, this.$.add(this.G(name), v));
  }
  dec(name: string, v: X): void {
    this.S(name, this.$.sub(this.G(name), v));
  }

  /* work-area access: zb + (idx << shift) with a constant region offset */
  private addr(idx: X | null, shift: number): void {
    this.c.globalGet(this.zb);
    if (idx !== null) {
      idx();
      if (shift !== 0) {
        this.c.i32Const(shift);
        this.c.i32Shl();
      }
      this.c.i32Add();
    }
  }
  /** The absolute address of region offset `off` plus a byte index. */
  abs(off: number, idx: X | null = null): X {
    return () => {
      this.addr(idx, 0);
      if (off !== 0) {
        this.c.i32Const(off);
        this.c.i32Add();
      }
    };
  }
  m8(off: number, idx: X | null = null): X {
    return () => {
      this.addr(idx, 0);
      this.c.load8UAt(off);
    };
  }
  m16(off: number, idx: X | null = null, shift = 1): X {
    return () => {
      this.addr(idx, shift);
      this.c.load16UAt(off);
    };
  }
  m32(off: number, idx: X | null = null, shift = 2): X {
    return () => {
      this.addr(idx, shift);
      this.c.load32At(off);
    };
  }
  s8(off: number, idx: X | null, v: X): void {
    this.addr(idx, 0);
    v();
    this.c.store8At(off);
  }
  s16(off: number, idx: X | null, v: X, shift = 1): void {
    this.addr(idx, shift);
    v();
    this.c.store16At(off);
  }
  s32(off: number, idx: X | null, v: X, shift = 2): void {
    this.addr(idx, shift);
    v();
    this.c.store32At(off);
  }
  /** ct_data: Freq/Code at +0, Dad/Len at +2, four bytes per entry. The
   * tree is a region offset held in a value (a parameter or constant). */
  fc(tree: X, n: X): X {
    return this.m16(0, this.$.add(this.$.shl(n, this.i(2)), tree), 0);
  }
  dl(tree: X, n: X): X {
    return this.m16(2, this.$.add(this.$.shl(n, this.i(2)), tree), 0);
  }
  setFc(tree: X, n: X, v: X): void {
    this.s16(0, this.$.add(this.$.shl(n, this.i(2)), tree), v, 0);
  }
  setDl(tree: X, n: X, v: X): void {
    this.s16(2, this.$.add(this.$.shl(n, this.i(2)), tree), v, 0);
  }

  /* control flow with labels */
  private depth(l: Label): number {
    const i = this.frames.lastIndexOf(l);
    if (i < 0) throw new Error("zlib.ts: branch to a label that is not open");
    return this.frames.length - 1 - i;
  }
  if(cond: X, then: () => void, els?: () => void): void {
    cond();
    this.c.ifVoid();
    this.frames.push({});
    then();
    if (els !== undefined) {
      this.c.else_();
      els();
    }
    this.frames.pop();
    this.c.end();
  }
  block(body: (out: Label) => void): void {
    const l: Label = {};
    this.c.block();
    this.frames.push(l);
    body(l);
    this.frames.pop();
    this.c.end();
  }
  loop(body: (top: Label) => void): void {
    const l: Label = {};
    this.c.loop();
    this.frames.push(l);
    body(l);
    this.frames.pop();
    this.c.end();
  }
  br(l: Label): void {
    this.c.br(this.depth(l));
  }
  brIf(l: Label, cond: X): void {
    cond();
    this.c.brIf(this.depth(l));
  }
  /** while (cond) body — `brk` leaves, `cont` re-tests. */
  while(cond: X, body: (brk: Label, cont: Label) => void): void {
    this.block((brk) =>
      this.loop((top) => {
        this.brIf(brk, this.$.not(cond));
        this.block((cont) => body(brk, cont));
        this.br(top);
      }),
    );
  }
  /** do body while (cond) — `cont` goes to the test. */
  doWhile(body: (brk: Label, cont: Label) => void, cond: X): void {
    this.block((brk) =>
      this.loop((top) => {
        this.block((cont) => body(brk, cont));
        this.brIf(top, cond);
      }),
    );
  }
  /** for (;;) body */
  forever(body: (brk: Label, cont: Label) => void): void {
    this.block((brk) =>
      this.loop((top) => {
        body(brk, top);
        this.br(top);
      }),
    );
  }
  /** for (i = from; i < to; i++) body — signed compare; `cont` steps. */
  for(i: number, from: X, to: X, body: (brk: Label, cont: Label) => void): void {
    this.put(i, from);
    this.block((brk) =>
      this.loop((top) => {
        this.brIf(brk, this.$.not(this.$.lt(this.l(i), to)));
        this.block((cont) => body(brk, cont));
        this.put(i, this.$.add(this.l(i), this.i(1)));
        this.br(top);
      }),
    );
  }
  /** switch (sel) { case 0: ... case n-1: ... } with C fallthrough: each
   * body runs into the next; `sel` outside 0..n-2 runs the last. */
  switch(sel: X, cases: (() => void)[]): void {
    const n = cases.length;
    const labels: Label[] = cases.map(() => ({}));
    for (let k = n - 1; k >= 0; k--) {
      this.c.block();
      this.frames.push(labels[k]!);
    }
    sel();
    this.c.brTable(
      labels.slice(0, n - 1).map((l) => this.depth(l)),
      this.depth(labels[n - 1]!),
    );
    for (let k = 0; k < n; k++) {
      this.frames.pop();
      this.c.end();
      cases[k]!();
    }
  }
  ret(v?: X): void {
    this.$.ret(v);
  }
}

/* ── the builder ───────────────────────────────────────────────────────── */

export class ZlibBuilder {
  private readonly fns = new Map<string, number>();
  private readonly globals = new Map<string, number>();
  private zbField: number | null = null;
  private inField: number | null = null;
  private outField: number | null = null;
  private dBlob: number | null = null;
  private iBlob: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: ZlibDeps,
  ) {}

  private get B(): number {
    return this.deps.bufType();
  }
  private get BT(): number {
    return this.deps.bytesType();
  }
  private get bRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.B };
  }
  private get btRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.BT };
  }

  private g(name: string): number {
    let idx = this.globals.get(name);
    if (idx === undefined) {
      idx = this.mb.addGlobal(I32, true, (w) => {
        w.u8(0x41);
        w.sleb(0);
      });
      this.globals.set(name, idx);
    }
    return idx;
  }
  private get zb(): number {
    return (this.zbField ??= this.g("%zb"));
  }
  /** The input and output byte arrays of the running call. */
  private get IN(): number {
    return (this.inField ??= this.mb.addGlobal(this.bRef, true, (w) => {
      w.u8(0xd0);
      w.sleb(this.B);
    }));
  }
  private get OUT(): number {
    return (this.outField ??= this.mb.addGlobal(this.bRef, true, (w) => {
      w.u8(0xd0);
      w.sleb(this.B);
    }));
  }

  /** The inflate error global (ZLIB_ERRORS ids), read when inflate answers
   * null. */
  errGlobal(): number {
    return this.g("%ierr");
  }

  private fn(name: string, params: ValType[], results: ValType[], build: (k: K) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.zlib.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    const k = new K(f, new A(f), this.zb, (n) => this.g(n));
    build(k);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  /** zb = the staging cursor rounded up to 16; memory grown to hold the
   * area; the static blob copied in. */
  private enterArea(k: K, blob: Uint8Array, blobAt: number, which: "d" | "i"): void {
    const c = k.c;
    this.deps.ensureCapacity(c, () => c.i32Const(AREA + 16));
    k.S("%zb", k.$.and(k.$.add(k.$.g(this.deps.stageCursor()), k.i(15)), k.i(-16)));
    let off: number;
    if (which === "d") off = this.dBlob ??= this.mb.internData(blob);
    else off = this.iBlob ??= this.mb.internData(blob);
    k.abs(blobAt)();
    c.i32Const(off);
    c.i32Const(blob.length);
    c.memoryInit(0);
  }

  /** memset(area + off, 0, n) */
  private zero(k: K, off: number, n: number): void {
    k.abs(off)();
    k.c.i32Const(0);
    k.c.i32Const(n);
    k.c.memoryFill();
  }

  /* ── adler32 ───────────────────────────────────────────────────────── */

  /** `(adler, arr, off, len) -> adler` over a byte array's range. */
  private adler32Fn(): number {
    return this.fn("adler32", [I32, this.bRef, I32, I32], [I32], (k) => {
      const [AD, ARR, OFF, LEN] = [0, 1, 2, 3];
      const $ = k.$;
      const A1 = k.local();
      const B1 = k.local();
      const N = k.local();
      const P = k.local();
      const END = k.local();
      const BASE = 65521;
      const NMAX = 5552;
      k.put(A1, $.and(k.l(AD), k.i(0xffff)));
      k.put(B1, $.shrU(k.l(AD), k.i(16)));
      k.put(P, k.l(OFF));
      k.while($.gtU(k.l(LEN), k.i(0)), () => {
        k.put(N, $.sel(I32, $.ltU(k.l(LEN), k.i(NMAX)), k.l(LEN), k.i(NMAX)));
        k.put(LEN, $.sub(k.l(LEN), k.l(N)));
        k.put(END, $.add(k.l(P), k.l(N)));
        k.while($.ltU(k.l(P), k.l(END)), () => {
          k.put(A1, $.add(k.l(A1), $.agetU(this.B, k.l(ARR), k.l(P))));
          k.put(B1, $.add(k.l(B1), k.l(A1)));
          k.put(P, $.add(k.l(P), k.i(1)));
        });
        k.put(A1, $.raw((c) => {
          c.localGet(A1);
          c.i32Const(BASE);
          c.i32RemU();
        }));
        k.put(B1, $.raw((c) => {
          c.localGet(B1);
          c.i32Const(BASE);
          c.i32RemU();
        }));
      });
      k.$.do($.or($.shl(k.l(B1), k.i(16)), k.l(A1)));
    });
  }

  /* ══ deflate ═══════════════════════════════════════════════════════ */

  /** put_byte */
  private putByteFn(): number {
    return this.fn("put_byte", [I32], [], (k) => {
      k.s8(D.PEND, k.G("pending"), k.l(0));
      k.inc("pending", k.i(1));
    });
  }

  /** put_short (LSB first) */
  private putShortFn(): number {
    return this.fn("put_short", [I32], [], (k) => {
      k.$.run(this.putByteFn(), k.$.and(k.l(0), k.i(0xff)));
      k.$.run(this.putByteFn(), k.$.and(k.$.shrU(k.l(0), k.i(8)), k.i(0xff)));
    });
  }

  /** send_bits(value, length) — the 16-bit bit buffer. */
  private sendBitsFn(): number {
    return this.fn("send_bits", [I32, I32], [], (k) => {
      const [V, LEN] = [0, 1];
      const $ = k.$;
      k.if($.gt(k.G("bi_valid"), $.sub(k.i(16), k.l(LEN))), () => {
        k.S("bi_buf", $.and($.or(k.G("bi_buf"), $.shl($.and(k.l(V), k.i(0xffff)), k.G("bi_valid"))), k.i(0xffff)));
        $.run(this.putShortFn(), k.G("bi_buf"));
        k.S("bi_buf", $.shrU($.and(k.l(V), k.i(0xffff)), $.sub(k.i(16), k.G("bi_valid"))));
        k.inc("bi_valid", $.sub(k.l(LEN), k.i(16)));
      }, () => {
        k.S("bi_buf", $.and($.or(k.G("bi_buf"), $.shl($.and(k.l(V), k.i(0xffff)), k.G("bi_valid"))), k.i(0xffff)));
        k.inc("bi_valid", k.l(LEN));
      });
    });
  }

  /** bi_flush */
  private biFlushFn(): number {
    return this.fn("bi_flush", [], [], (k) => {
      const $ = k.$;
      k.if($.eq(k.G("bi_valid"), k.i(16)), () => {
        $.run(this.putShortFn(), k.G("bi_buf"));
        k.S("bi_buf", k.i(0));
        k.S("bi_valid", k.i(0));
      }, () => {
        k.if($.ge(k.G("bi_valid"), k.i(8)), () => {
          $.run(this.putByteFn(), $.and(k.G("bi_buf"), k.i(0xff)));
          k.S("bi_buf", $.shrU(k.G("bi_buf"), k.i(8)));
          k.dec("bi_valid", k.i(8));
        });
      });
    });
  }

  /** bi_windup */
  private biWindupFn(): number {
    return this.fn("bi_windup", [], [], (k) => {
      const $ = k.$;
      k.if($.gt(k.G("bi_valid"), k.i(8)), () => {
        $.run(this.putShortFn(), k.G("bi_buf"));
      }, () => {
        k.if($.gt(k.G("bi_valid"), k.i(0)), () => $.run(this.putByteFn(), $.and(k.G("bi_buf"), k.i(0xff))));
      });
      k.S("bi_buf", k.i(0));
      k.S("bi_valid", k.i(0));
    });
  }

  /** flush_pending: pending_buf → the output array at next_out. */
  private flushPendingFn(): number {
    return this.fn("flush_pending", [], [], (k) => {
      const $ = k.$;
      const LEN = k.local();
      const J = k.local();
      $.run(this.biFlushFn());
      k.put(LEN, k.G("pending"));
      k.if($.gtU(k.l(LEN), k.G("avail_out")), () => k.put(LEN, k.G("avail_out")));
      k.if($.eq(k.l(LEN), k.i(0)), () => k.ret());
      k.for(J, k.i(0), k.l(LEN), () => {
        $.aset(this.B, $.g(this.OUT), $.add(k.G("next_out"), k.l(J)), k.m8(D.PEND, $.add(k.G("pend_out"), k.l(J))));
      });
      k.inc("next_out", k.l(LEN));
      k.inc("pend_out", k.l(LEN));
      k.inc("total_out", k.l(LEN));
      k.dec("avail_out", k.l(LEN));
      k.dec("pending", k.l(LEN));
      k.if($.eq(k.G("pending"), k.i(0)), () => k.S("pend_out", k.i(0)));
    });
  }

  /** read_buf into the window (region offset `dst`): `(dst, size) -> n` */
  private readBufFn(): number {
    return this.fn("read_buf", [I32, I32], [I32], (k) => {
      const [DST, SIZE] = [0, 1];
      const $ = k.$;
      const LEN = k.local();
      const J = k.local();
      k.put(LEN, k.G("avail_in"));
      k.if($.gtU(k.l(LEN), k.l(SIZE)), () => k.put(LEN, k.l(SIZE)));
      k.if($.eq(k.l(LEN), k.i(0)), () => k.ret(k.i(0)));
      k.dec("avail_in", k.l(LEN));
      k.for(J, k.i(0), k.l(LEN), () => {
        k.s8(0, $.add(k.l(DST), k.l(J)), $.agetU(this.B, $.g(this.IN), $.add(k.G("next_in"), k.l(J))));
      });
      // wrap == 1: the adler32 of what was read
      k.S("adler", $.call(this.adler32Fn(), k.G("adler"), $.g(this.IN), k.G("next_in"), k.l(LEN)));
      k.inc("next_in", k.l(LEN));
      k.inc("total_in", k.l(LEN));
      k.ret(k.l(LEN));
    });
  }

  /** read_buf straight to next_out (deflate_stored): `(len)` */
  private readBufOutFn(): number {
    return this.fn("read_buf_out", [I32], [], (k) => {
      const LEN = 0;
      const $ = k.$;
      k.if($.eq(k.l(LEN), k.i(0)), () => k.ret());
      k.dec("avail_in", k.l(LEN));
      $.do($.g(this.OUT), k.G("next_out"), $.g(this.IN), k.G("next_in"), k.l(LEN));
      k.c.arrayCopy(this.B, this.B);
      k.S("adler", $.call(this.adler32Fn(), k.G("adler"), $.g(this.IN), k.G("next_in"), k.l(LEN)));
      k.inc("next_in", k.l(LEN));
      k.inc("total_in", k.l(LEN));
    });
  }

  /** insert_string (Chromium's hash): `(str) -> previous head` */
  private insertStringFn(): number {
    return this.fn("insert_string", [I32], [I32], (k) => {
      const STR = 0;
      const $ = k.$;
      const RET = k.local();
      // ((value * 66521 + 66521) >> 16) & hash_mask, value the window's
      // four bytes at str read little-endian
      k.S("ins_h", $.and($.shrU($.add($.mul(k.m32(D.WIN, k.l(STR), 0), k.i(66521)), k.i(66521)), k.i(16)), k.i(HASH_MASK)));
      k.put(RET, k.m16(D.HEAD, k.G("ins_h")));
      k.s16(D.PREV, $.and(k.l(STR), k.i(W_MASK)), k.l(RET));
      k.s16(D.HEAD, k.G("ins_h"), k.l(STR));
      k.ret(k.l(RET));
    });
  }

  /** slide_hash */
  private slideHashFn(): number {
    return this.fn("slide_hash", [], [], (k) => {
      const $ = k.$;
      const N = k.local();
      const M = k.local();
      for (const [region, count] of [[D.HEAD, HASH_SIZE], [D.PREV, W_SIZE]] as const) {
        k.for(N, k.i(0), k.i(count), () => {
          k.put(M, k.m16(region, k.l(N)));
          k.s16(region, k.l(N), $.sel(I32, $.geU(k.l(M), k.i(W_SIZE)), $.sub(k.l(M), k.i(W_SIZE)), k.i(0)));
        });
      }
    });
  }

  /** fill_window */
  private fillWindowFn(): number {
    return this.fn("fill_window", [], [], (k) => {
      const $ = k.$;
      const N = k.local();
      const MORE = k.local();
      const STR = k.local();
      const CURR = k.local();
      const INIT = k.local();
      k.doWhile((brk) => {
        k.put(MORE, $.sub($.sub(k.i(WINDOW_SIZE), k.G("lookahead")), k.G("strstart")));
        k.if($.geU(k.G("strstart"), k.i(W_SIZE + MAX_DIST)), () => {
          k.abs(D.WIN)();
          k.abs(D.WIN + W_SIZE)();
          $.do($.sub(k.i(W_SIZE), k.l(MORE)));
          k.c.memoryCopy();
          k.dec("match_start", k.i(W_SIZE));
          k.dec("strstart", k.i(W_SIZE));
          k.dec("block_start", k.i(W_SIZE));
          k.if($.gtU(k.G("insert"), k.G("strstart")), () => k.S("insert", k.G("strstart")));
          $.run(this.slideHashFn());
          k.put(MORE, $.add(k.l(MORE), k.i(W_SIZE)));
        });
        k.brIf(brk, $.eq(k.G("avail_in"), k.i(0)));
        k.put(N, $.call(this.readBufFn(), $.add(k.i(D.WIN), $.add(k.G("strstart"), k.G("lookahead"))), k.l(MORE)));
        k.inc("lookahead", k.l(N));
        // Chromium's hash reads four bytes
        k.if($.gtU($.add(k.G("lookahead"), k.G("insert")), k.i(MIN_MATCH)), () => {
          k.put(STR, $.sub(k.G("strstart"), k.G("insert")));
          k.while($.ne(k.G("insert"), k.i(0)), (brk2) => {
            $.drop($.call(this.insertStringFn(), k.l(STR)));
            k.put(STR, $.add(k.l(STR), k.i(1)));
            k.dec("insert", k.i(1));
            k.brIf(brk2, $.leU($.add(k.G("lookahead"), k.G("insert")), k.i(MIN_MATCH)));
          });
        });
      }, $.andThen($.ltU(k.G("lookahead"), k.i(MIN_LOOKAHEAD)), $.ne(k.G("avail_in"), k.i(0))));
      // zero WIN_INIT bytes past the data (the high water mark)
      k.if($.ltU(k.G("high_water"), k.i(WINDOW_SIZE)), () => {
        k.put(CURR, $.add(k.G("strstart"), k.G("lookahead")));
        k.if($.ltU(k.G("high_water"), k.l(CURR)), () => {
          k.put(INIT, $.sub(k.i(WINDOW_SIZE), k.l(CURR)));
          k.if($.gtU(k.l(INIT), k.i(WIN_INIT)), () => k.put(INIT, k.i(WIN_INIT)));
          k.abs(D.WIN, k.l(CURR))();
          k.c.i32Const(0);
          k.l(INIT)();
          k.c.memoryFill();
          k.S("high_water", $.add(k.l(CURR), k.l(INIT)));
        }, () => {
          k.if($.ltU(k.G("high_water"), $.add(k.l(CURR), k.i(WIN_INIT))), () => {
            k.put(INIT, $.sub($.add(k.l(CURR), k.i(WIN_INIT)), k.G("high_water")));
            k.if($.gtU(k.l(INIT), $.sub(k.i(WINDOW_SIZE), k.G("high_water"))), () => k.put(INIT, $.sub(k.i(WINDOW_SIZE), k.G("high_water"))));
            k.abs(D.WIN, k.G("high_water"))();
            k.c.i32Const(0);
            k.l(INIT)();
            k.c.memoryFill();
            k.inc("high_water", k.l(INIT));
          });
        });
      });
    });
  }

  /** longest_match(cur_match) -> length; sets match_start. The byte-wise
   * path (no UNALIGNED_OK); its eight-way unrolled compare stops at
   * exactly the first mismatch in strstart+3 .. strstart+258, as this
   * loop does. */
  private longestMatchFn(): number {
    return this.fn("longest_match", [I32], [I32], (k) => {
      const CUR = 0;
      const $ = k.$;
      const CHAIN = k.local();
      const SCAN = k.local();
      const MATCH = k.local();
      const LEN = k.local();
      const BEST = k.local();
      const NICE = k.local();
      const LIMIT = k.local();
      const E1 = k.local();
      const E0 = k.local();
      const w = (p: X): X => k.m8(D.WIN, p);
      k.put(CHAIN, k.G("max_chain"));
      k.put(SCAN, k.G("strstart"));
      k.put(BEST, k.G("prev_length"));
      k.put(NICE, k.G("nice_match"));
      k.put(LIMIT, $.sel(I32, $.gtU(k.G("strstart"), k.i(MAX_DIST)), $.sub(k.G("strstart"), k.i(MAX_DIST)), k.i(0)));
      k.put(E1, w($.sub($.add(k.l(SCAN), k.l(BEST)), k.i(1))));
      k.put(E0, w($.add(k.l(SCAN), k.l(BEST))));
      k.if($.geU(k.G("prev_length"), k.G("good_match")), () => k.put(CHAIN, $.shrU(k.l(CHAIN), k.i(2))));
      k.if($.gtU(k.l(NICE), k.G("lookahead")), () => k.put(NICE, k.G("lookahead")));
      k.doWhile((brk, cont) => {
        k.put(MATCH, k.l(CUR));
        k.brIf(cont, $.ne(w($.add(k.l(MATCH), k.l(BEST))), k.l(E0)));
        k.brIf(cont, $.ne(w($.sub($.add(k.l(MATCH), k.l(BEST)), k.i(1))), k.l(E1)));
        k.brIf(cont, $.ne(w(k.l(MATCH)), w(k.l(SCAN))));
        k.brIf(cont, $.ne(w($.add(k.l(MATCH), k.i(1))), w($.add(k.l(SCAN), k.i(1)))));
        // scan[2] is not compared (the hash covers it, or a later byte
        // differs); the run starts at +3
        k.put(LEN, k.i(3));
        k.while($.andThen($.lt(k.l(LEN), k.i(MAX_MATCH)), $.eq(w($.add(k.l(SCAN), k.l(LEN))), w($.add(k.l(MATCH), k.l(LEN))))), () => {
          k.put(LEN, $.add(k.l(LEN), k.i(1)));
        });
        k.if($.gt(k.l(LEN), k.l(BEST)), () => {
          k.S("match_start", k.l(CUR));
          k.put(BEST, k.l(LEN));
          k.brIf(brk, $.ge(k.l(LEN), k.l(NICE)));
          k.put(E1, w($.sub($.add(k.l(SCAN), k.l(BEST)), k.i(1))));
          k.put(E0, w($.add(k.l(SCAN), k.l(BEST))));
        });
      }, () => {
        // (cur_match = prev[cur_match & wmask]) > limit && --chain_length != 0
        k.put(CUR, k.m16(D.PREV, $.and(k.l(CUR), k.i(W_MASK))));
        k.c.localGet(CUR);
        k.c.localGet(LIMIT);
        k.c.i32GtU();
        k.c.ifResult(I32);
        k.put(CHAIN, $.sub(k.l(CHAIN), k.i(1)));
        k.c.localGet(CHAIN);
        k.c.i32Const(0);
        k.c.i32Ne();
        k.c.else_();
        k.c.i32Const(0);
        k.c.end();
      });
      k.ret($.sel(I32, $.leU(k.l(BEST), k.G("lookahead")), k.l(BEST), k.G("lookahead")));
    });
  }

  /* ── trees.c ──────────────────────────────────────────────────────── */

  /** init_block */
  private initBlockFn(): number {
    return this.fn("init_block", [], [], (k) => {
      const N = k.local();
      for (const [tree, n] of [[D.LTREE, L_CODES], [D.DTREE, D_CODES], [D.BLTREE, BL_CODES]] as const) {
        k.for(N, k.i(0), k.i(n), () => k.setFc(k.i(tree), k.l(N), k.i(0)));
      }
      k.setFc(k.i(D.LTREE), k.i(END_BLOCK), k.i(1));
      k.S("opt_len", k.i(0));
      k.S("static_len", k.i(0));
      k.S("sym_next", k.i(0));
      k.S("matches", k.i(0));
    });
  }

  /** smaller(tree, n, m): freq, then depth, as the tie breaker */
  private smallerFn(): number {
    return this.fn("smaller", [I32, I32, I32], [I32], (k) => {
      const [T, N, M] = [0, 1, 2];
      const $ = k.$;
      const FN = k.local();
      const FM = k.local();
      k.put(FN, k.fc(k.l(T), k.l(N)));
      k.put(FM, k.fc(k.l(T), k.l(M)));
      k.ret($.orElse($.ltU(k.l(FN), k.l(FM)), $.andThen($.eq(k.l(FN), k.l(FM)), $.leU(k.m8(D.DEPTH, k.l(N)), k.m8(D.DEPTH, k.l(M))))));
    });
  }

  /** pqdownheap(tree, k) */
  private pqdownheapFn(): number {
    return this.fn("pqdownheap", [I32, I32], [], (k) => {
      const [T, KK] = [0, 1];
      const $ = k.$;
      const V = k.local();
      const J = k.local();
      const heap = (i: X): X => k.m32(D.HEAP, i);
      k.put(V, heap(k.l(KK)));
      k.put(J, $.shl(k.l(KK), k.i(1)));
      k.while($.le(k.l(J), k.G("heap_len")), (brk) => {
        k.if($.andThen($.lt(k.l(J), k.G("heap_len")), $.call(this.smallerFn(), k.l(T), heap($.add(k.l(J), k.i(1))), heap(k.l(J)))), () => {
          k.put(J, $.add(k.l(J), k.i(1)));
        });
        k.brIf(brk, $.call(this.smallerFn(), k.l(T), k.l(V), heap(k.l(J))));
        k.s32(D.HEAP, k.l(KK), heap(k.l(J)));
        k.put(KK, k.l(J));
        k.put(J, $.shl(k.l(J), k.i(1)));
      });
      k.s32(D.HEAP, k.l(KK), k.l(V));
    });
  }

  /** gen_bitlen(tree, max_code, stree (-1 none), extra, base, max_length) */
  private genBitlenFn(): number {
    return this.fn("gen_bitlen", [I32, I32, I32, I32, I32, I32], [], (k) => {
      const [T, MAXC, ST, EX, BASE, MAXLEN] = [0, 1, 2, 3, 4, 5];
      const $ = k.$;
      const H = k.local();
      const N = k.local();
      const M = k.local();
      const BITS = k.local();
      const XB = k.local();
      const F = k.local();
      const OVF = k.local();
      const heap = (i: X): X => k.m32(D.HEAP, i);
      const blc = (b: X): X => k.m16(D.BLCOUNT, b);
      k.for(BITS, k.i(0), k.i(MAX_BITS + 1), () => k.s16(D.BLCOUNT, k.l(BITS), k.i(0)));
      k.setDl(k.l(T), heap(k.G("heap_max")), k.i(0));
      k.for(H, $.add(k.G("heap_max"), k.i(1)), k.i(HEAP_SIZE), (_b, cont) => {
        k.put(N, heap(k.l(H)));
        k.put(BITS, $.add(k.dl(k.l(T), k.dl(k.l(T), k.l(N))), k.i(1)));
        k.if($.gt(k.l(BITS), k.l(MAXLEN)), () => {
          k.put(BITS, k.l(MAXLEN));
          k.put(OVF, $.add(k.l(OVF), k.i(1)));
        });
        k.setDl(k.l(T), k.l(N), k.l(BITS));
        k.brIf(cont, $.gt(k.l(N), k.l(MAXC)));
        k.s16(D.BLCOUNT, k.l(BITS), $.add(blc(k.l(BITS)), k.i(1)));
        k.put(XB, k.i(0));
        k.if($.ge(k.l(N), k.l(BASE)), () => k.put(XB, k.m32(0, $.add(k.l(EX), $.shl($.sub(k.l(N), k.l(BASE)), k.i(2))), 0)));
        k.put(F, k.fc(k.l(T), k.l(N)));
        k.inc("opt_len", $.mul(k.l(F), $.add(k.l(BITS), k.l(XB))));
        k.if($.ge(k.l(ST), k.i(0)), () => k.inc("static_len", $.mul(k.l(F), $.add(k.dl(k.l(ST), k.l(N)), k.l(XB)))));
      });
      k.if($.eq(k.l(OVF), k.i(0)), () => k.ret());
      k.doWhile(() => {
        k.put(BITS, $.sub(k.l(MAXLEN), k.i(1)));
        k.while($.eq(blc(k.l(BITS)), k.i(0)), () => k.put(BITS, $.sub(k.l(BITS), k.i(1))));
        k.s16(D.BLCOUNT, k.l(BITS), $.sub(blc(k.l(BITS)), k.i(1)));
        k.s16(D.BLCOUNT, $.add(k.l(BITS), k.i(1)), $.add(blc($.add(k.l(BITS), k.i(1))), k.i(2)));
        k.s16(D.BLCOUNT, k.l(MAXLEN), $.sub(blc(k.l(MAXLEN)), k.i(1)));
        k.put(OVF, $.sub(k.l(OVF), k.i(2)));
      }, $.gt(k.l(OVF), k.i(0)));
      k.put(BITS, k.l(MAXLEN));
      k.while($.ne(k.l(BITS), k.i(0)), () => {
        k.put(N, blc(k.l(BITS)));
        k.while($.ne(k.l(N), k.i(0)), (_b, cont) => {
          k.put(H, $.sub(k.l(H), k.i(1)));
          k.put(M, heap(k.l(H)));
          k.brIf(cont, $.gt(k.l(M), k.l(MAXC)));
          k.if($.ne(k.dl(k.l(T), k.l(M)), k.l(BITS)), () => {
            k.inc("opt_len", $.mul($.sub(k.l(BITS), k.dl(k.l(T), k.l(M))), k.fc(k.l(T), k.l(M))));
            k.setDl(k.l(T), k.l(M), k.l(BITS));
          });
          k.put(N, $.sub(k.l(N), k.i(1)));
        });
        k.put(BITS, $.sub(k.l(BITS), k.i(1)));
      });
    });
  }

  /** gen_codes(tree, max_code) over bl_count */
  private genCodesFn(): number {
    return this.fn("gen_codes", [I32, I32], [], (k) => {
      const [T, MAXC] = [0, 1];
      const $ = k.$;
      const CODE = k.local();
      const BITS = k.local();
      const N = k.local();
      const LEN = k.local();
      const NC = k.local();
      const R = k.local();
      k.for(BITS, k.i(1), k.i(MAX_BITS + 1), () => {
        k.put(CODE, $.shl($.add(k.l(CODE), k.m16(D.BLCOUNT, $.sub(k.l(BITS), k.i(1)))), k.i(1)));
        k.s16(D.NEXTCODE, k.l(BITS), k.l(CODE));
      });
      k.for(N, k.i(0), $.add(k.l(MAXC), k.i(1)), (_b, cont) => {
        k.put(LEN, k.dl(k.l(T), k.l(N)));
        k.brIf(cont, $.eq(k.l(LEN), k.i(0)));
        k.put(NC, k.m16(D.NEXTCODE, k.l(LEN)));
        k.s16(D.NEXTCODE, k.l(LEN), $.add(k.l(NC), k.i(1)));
        // bi_reverse(code, len)
        k.put(R, k.i(0));
        k.doWhile(() => {
          k.put(R, $.or(k.l(R), $.and(k.l(NC), k.i(1))));
          k.put(NC, $.shrU(k.l(NC), k.i(1)));
          k.put(R, $.shl(k.l(R), k.i(1)));
          k.put(LEN, $.sub(k.l(LEN), k.i(1)));
        }, $.gt(k.l(LEN), k.i(0)));
        k.setFc(k.l(T), k.l(N), $.shrU(k.l(R), k.i(1)));
      });
    });
  }

  /** build_tree(tree, stree (-1 none), extra, base, elems, max_length)
   * -> max_code */
  private buildTreeFn(): number {
    return this.fn("build_tree", [I32, I32, I32, I32, I32, I32], [I32], (k) => {
      const [T, ST, EX, BASE, ELEMS, MAXLEN] = [0, 1, 2, 3, 4, 5];
      const $ = k.$;
      const N = k.local();
      const M = k.local();
      const MAXC = k.local();
      const NODE = k.local();
      const heap = (i: X): X => k.m32(D.HEAP, i);
      const depth = (i: X): X => k.m8(D.DEPTH, i);
      k.S("heap_len", k.i(0));
      k.S("heap_max", k.i(HEAP_SIZE));
      k.put(MAXC, k.i(-1));
      k.for(N, k.i(0), k.l(ELEMS), () => {
        k.if($.ne(k.fc(k.l(T), k.l(N)), k.i(0)), () => {
          k.inc("heap_len", k.i(1));
          k.put(MAXC, k.l(N));
          k.s32(D.HEAP, k.G("heap_len"), k.l(N));
          k.s8(D.DEPTH, k.l(N), k.i(0));
        }, () => k.setDl(k.l(T), k.l(N), k.i(0)));
      });
      k.while($.lt(k.G("heap_len"), k.i(2)), () => {
        k.inc("heap_len", k.i(1));
        k.if($.lt(k.l(MAXC), k.i(2)), () => {
          k.put(MAXC, $.add(k.l(MAXC), k.i(1)));
          k.put(NODE, k.l(MAXC));
        }, () => k.put(NODE, k.i(0)));
        k.s32(D.HEAP, k.G("heap_len"), k.l(NODE));
        k.setFc(k.l(T), k.l(NODE), k.i(1));
        k.s8(D.DEPTH, k.l(NODE), k.i(0));
        k.dec("opt_len", k.i(1));
        k.if($.ge(k.l(ST), k.i(0)), () => k.dec("static_len", k.dl(k.l(ST), k.l(NODE))));
      });
      // heap_len / 2 down to 1
      k.put(N, $.shrU(k.G("heap_len"), k.i(1)));
      k.while($.ge(k.l(N), k.i(1)), () => {
        $.run(this.pqdownheapFn(), k.l(T), k.l(N));
        k.put(N, $.sub(k.l(N), k.i(1)));
      });
      k.put(NODE, k.l(ELEMS));
      k.doWhile(() => {
        // pqremove
        k.put(N, heap(k.i(1)));
        k.s32(D.HEAP, k.i(1), heap(k.G("heap_len")));
        k.dec("heap_len", k.i(1));
        $.run(this.pqdownheapFn(), k.l(T), k.i(1));
        k.put(M, heap(k.i(1)));
        k.dec("heap_max", k.i(1));
        k.s32(D.HEAP, k.G("heap_max"), k.l(N));
        k.dec("heap_max", k.i(1));
        k.s32(D.HEAP, k.G("heap_max"), k.l(M));
        k.setFc(k.l(T), k.l(NODE), $.and($.add(k.fc(k.l(T), k.l(N)), k.fc(k.l(T), k.l(M))), k.i(0xffff)));
        k.s8(D.DEPTH, k.l(NODE), $.add($.sel(I32, $.geU(depth(k.l(N)), depth(k.l(M))), depth(k.l(N)), depth(k.l(M))), k.i(1)));
        k.setDl(k.l(T), k.l(N), k.l(NODE));
        k.setDl(k.l(T), k.l(M), k.l(NODE));
        k.s32(D.HEAP, k.i(1), k.l(NODE));
        k.put(NODE, $.add(k.l(NODE), k.i(1)));
        $.run(this.pqdownheapFn(), k.l(T), k.i(1));
      }, $.ge(k.G("heap_len"), k.i(2)));
      k.dec("heap_max", k.i(1));
      k.s32(D.HEAP, k.G("heap_max"), heap(k.i(1)));
      $.run(this.genBitlenFn(), k.l(T), k.l(MAXC), k.l(ST), k.l(EX), k.l(BASE), k.l(MAXLEN));
      $.run(this.genCodesFn(), k.l(T), k.l(MAXC));
      k.ret(k.l(MAXC));
    });
  }

  /** scan_tree(tree, max_code) */
  private scanTreeFn(): number {
    return this.fn("scan_tree", [I32, I32], [], (k) => {
      const [T, MAXC] = [0, 1];
      const $ = k.$;
      const bl = (n: X): X => k.fc(k.i(D.BLTREE), n);
      const bump = (n: X, by: X): void => k.setFc(k.i(D.BLTREE), n, $.and($.add(bl(n), by), k.i(0xffff)));
      k.setDl(k.l(T), $.add(k.l(MAXC), k.i(1)), k.i(0xffff)); // guard
      // the min-count local is allocated by treeRuns; read it through a
      // closure set before the emit runs
      let MIN = -1;
      this.treeRunsWithMin(k, T, MAXC, (m) => (MIN = m), (CUR, COUNT, PREV) => {
        k.if($.lt(k.l(COUNT), k.l(MIN)), () => bump(k.l(CUR), k.l(COUNT)), () => {
          k.if($.ne(k.l(CUR), k.i(0)), () => {
            k.if($.ne(k.l(CUR), k.l(PREV)), () => bump(k.l(CUR), k.i(1)));
            bump(k.i(16), k.i(1));
          }, () => {
            k.if($.le(k.l(COUNT), k.i(10)), () => bump(k.i(17), k.i(1)), () => bump(k.i(18), k.i(1)));
          });
        });
      });
    });
  }

  /** send_tree(tree, max_code) */
  private sendTreeFn(): number {
    return this.fn("send_tree", [I32, I32], [], (k) => {
      const [T, MAXC] = [0, 1];
      const $ = k.$;
      const code = (n: X): void => $.run(this.sendBitsFn(), k.fc(k.i(D.BLTREE), n), k.dl(k.i(D.BLTREE), n));
      let MIN = -1;
      this.treeRunsWithMin(k, T, MAXC, (m) => (MIN = m), (CUR, COUNT, PREV) => {
        k.if($.lt(k.l(COUNT), k.l(MIN)), () => {
          k.doWhile(() => code(k.l(CUR)), $.ne($.tee(COUNT, $.sub(k.l(COUNT), k.i(1))), k.i(0)));
        }, () => {
          k.if($.ne(k.l(CUR), k.i(0)), () => {
            k.if($.ne(k.l(CUR), k.l(PREV)), () => {
              code(k.l(CUR));
              k.put(COUNT, $.sub(k.l(COUNT), k.i(1)));
            });
            code(k.i(16));
            $.run(this.sendBitsFn(), $.sub(k.l(COUNT), k.i(3)), k.i(2));
          }, () => {
            k.if($.le(k.l(COUNT), k.i(10)), () => {
              code(k.i(17));
              $.run(this.sendBitsFn(), $.sub(k.l(COUNT), k.i(3)), k.i(3));
            }, () => {
              code(k.i(18));
              $.run(this.sendBitsFn(), $.sub(k.l(COUNT), k.i(11)), k.i(7));
            });
          });
        });
      });
    });
  }

  /** treeRuns, handing the min_count local to the caller first. */
  private treeRunsWithMin(k: K, T: number, MAXC: number, onMin: (m: number) => void, emit: (cur: number, count: number, prev: number) => void): void {
    const $ = k.$;
    const N = k.local();
    const PREV = k.local();
    const CUR = k.local();
    const NEXT = k.local();
    const COUNT = k.local();
    const MAXCNT = k.local();
    const MINCNT = k.local();
    onMin(MINCNT);
    k.put(PREV, k.i(-1));
    k.put(NEXT, k.dl(k.l(T), k.i(0)));
    k.put(COUNT, k.i(0));
    k.put(MAXCNT, k.i(7));
    k.put(MINCNT, k.i(4));
    k.if($.eq(k.l(NEXT), k.i(0)), () => {
      k.put(MAXCNT, k.i(138));
      k.put(MINCNT, k.i(3));
    });
    k.for(N, k.i(0), $.add(k.l(MAXC), k.i(1)), (_b, cont) => {
      k.put(CUR, k.l(NEXT));
      k.put(NEXT, k.dl(k.l(T), $.add(k.l(N), k.i(1))));
      k.put(COUNT, $.add(k.l(COUNT), k.i(1)));
      k.brIf(cont, $.andThen($.lt(k.l(COUNT), k.l(MAXCNT)), $.eq(k.l(CUR), k.l(NEXT))));
      emit(CUR, COUNT, PREV);
      k.put(COUNT, k.i(0));
      k.put(PREV, k.l(CUR));
      k.if($.eq(k.l(NEXT), k.i(0)), () => {
        k.put(MAXCNT, k.i(138));
        k.put(MINCNT, k.i(3));
      }, () => {
        k.if($.eq(k.l(CUR), k.l(NEXT)), () => {
          k.put(MAXCNT, k.i(6));
          k.put(MINCNT, k.i(3));
        }, () => {
          k.put(MAXCNT, k.i(7));
          k.put(MINCNT, k.i(4));
        });
      });
    });
  }

  /** build_bl_tree() -> max_blindex */
  private buildBlTreeFn(): number {
    return this.fn("build_bl_tree", [], [I32], (k) => {
      const $ = k.$;
      const MB = k.local();
      $.run(this.scanTreeFn(), k.i(D.LTREE), k.G("l_max"));
      $.run(this.scanTreeFn(), k.i(D.DTREE), k.G("d_max"));
      k.S("bl_max", $.call(this.buildTreeFn(), k.i(D.BLTREE), k.i(-1), k.i(D.XBLBITS), k.i(0), k.i(BL_CODES), k.i(MAX_BL_BITS)));
      k.put(MB, k.i(BL_CODES - 1));
      k.while($.ge(k.l(MB), k.i(3)), (brk) => {
        k.brIf(brk, $.ne(k.dl(k.i(D.BLTREE), k.m8(D.BLORDER, k.l(MB))), k.i(0)));
        k.put(MB, $.sub(k.l(MB), k.i(1)));
      });
      k.inc("opt_len", $.add($.mul(k.i(3), $.add(k.l(MB), k.i(1))), k.i(14)));
      k.ret(k.l(MB));
    });
  }

  /** send_all_trees(lcodes, dcodes, blcodes) */
  private sendAllTreesFn(): number {
    return this.fn("send_all_trees", [I32, I32, I32], [], (k) => {
      const [LC, DC, BLC] = [0, 1, 2];
      const $ = k.$;
      const R = k.local();
      $.run(this.sendBitsFn(), $.sub(k.l(LC), k.i(257)), k.i(5));
      $.run(this.sendBitsFn(), $.sub(k.l(DC), k.i(1)), k.i(5));
      $.run(this.sendBitsFn(), $.sub(k.l(BLC), k.i(4)), k.i(4));
      k.for(R, k.i(0), k.l(BLC), () => {
        $.run(this.sendBitsFn(), k.dl(k.i(D.BLTREE), k.m8(D.BLORDER, k.l(R))), k.i(3));
      });
      $.run(this.sendTreeFn(), k.i(D.LTREE), $.sub(k.l(LC), k.i(1)));
      $.run(this.sendTreeFn(), k.i(D.DTREE), $.sub(k.l(DC), k.i(1)));
    });
  }

  /** d_code(dist) */
  private dCode(k: K, dist: X): X {
    const $ = k.$;
    return $.sel(I32, $.ltU(dist, k.i(256)), k.m8(D.DISTCODE, dist), k.m8(D.DISTCODE + 256, $.shrU(dist, k.i(7))));
  }

  /** compress_block(ltree, dtree) */
  private compressBlockFn(): number {
    return this.fn("compress_block", [I32, I32], [], (k) => {
      const [LT, DT] = [0, 1];
      const $ = k.$;
      const DIST = k.local();
      const LC = k.local();
      const SX = k.local();
      const CODE = k.local();
      const EXTRA = k.local();
      const sendCode = (c: X, tree: X): void => $.run(this.sendBitsFn(), k.fc(tree, c), k.dl(tree, c));
      k.if($.ne(k.G("sym_next"), k.i(0)), () => {
        k.doWhile(() => {
          k.put(DIST, k.m16(D_BUF, k.l(SX)));
          k.put(LC, k.m8(L_BUF, k.l(SX)));
          k.put(SX, $.add(k.l(SX), k.i(1)));
          k.if($.eq(k.l(DIST), k.i(0)), () => sendCode(k.l(LC), k.l(LT)), () => {
            k.put(CODE, k.m8(D.LENCODE, k.l(LC)));
            sendCode($.add(k.l(CODE), k.i(LITERALS + 1)), k.l(LT));
            k.put(EXTRA, k.m32(D.XLBITS, k.l(CODE)));
            k.if($.ne(k.l(EXTRA), k.i(0)), () => {
              k.put(LC, $.sub(k.l(LC), k.m32(D.BASELEN, k.l(CODE))));
              $.run(this.sendBitsFn(), k.l(LC), k.l(EXTRA));
            });
            k.put(DIST, $.sub(k.l(DIST), k.i(1)));
            k.put(CODE, this.dCode(k, k.l(DIST)));
            sendCode(k.l(CODE), k.l(DT));
            k.put(EXTRA, k.m32(D.XDBITS, k.l(CODE)));
            k.if($.ne(k.l(EXTRA), k.i(0)), () => {
              k.put(DIST, $.sub(k.l(DIST), k.m32(D.BASEDIST, k.l(CODE))));
              $.run(this.sendBitsFn(), k.l(DIST), k.l(EXTRA));
            });
          });
        }, $.ltU(k.l(SX), k.G("sym_next")));
      });
      sendCode(k.i(END_BLOCK), k.l(LT));
    });
  }

  /** _tr_stored_block(buf (window offset, -1 none), stored_len, last) */
  private storedBlockFn(): number {
    return this.fn("tr_stored_block", [I32, I32, I32], [], (k) => {
      const [BUF, LEN, LAST] = [0, 1, 2];
      const $ = k.$;
      $.run(this.sendBitsFn(), k.l(LAST), k.i(3)); // (STORED_BLOCK << 1) + last
      $.run(this.biWindupFn());
      $.run(this.putShortFn(), $.and(k.l(LEN), k.i(0xffff)));
      $.run(this.putShortFn(), $.and($.xor(k.l(LEN), k.i(-1)), k.i(0xffff)));
      k.if($.ne(k.l(LEN), k.i(0)), () => {
        k.abs(D.PEND, k.G("pending"))();
        k.abs(0, k.l(BUF))();
        k.l(LEN)();
        k.c.memoryCopy();
      });
      k.inc("pending", k.l(LEN));
    });
  }

  /** _tr_flush_block(buf (window offset, -1 none), stored_len, last) */
  private flushBlockFn(): number {
    return this.fn("tr_flush_block", [I32, I32, I32], [], (k) => {
      const [BUF, LEN, LAST] = [0, 1, 2];
      const $ = k.$;
      const OPT = k.local();
      const STAT = k.local();
      const MB = k.local();
      k.if($.gt(k.G("level"), k.i(0)), () => {
        k.S("l_max", $.call(this.buildTreeFn(), k.i(D.LTREE), k.i(D.SLTREE), k.i(D.XLBITS), k.i(LITERALS + 1), k.i(L_CODES), k.i(MAX_BITS)));
        k.S("d_max", $.call(this.buildTreeFn(), k.i(D.DTREE), k.i(D.SDTREE), k.i(D.XDBITS), k.i(0), k.i(D_CODES), k.i(MAX_BITS)));
        k.put(MB, $.call(this.buildBlTreeFn()));
        k.put(OPT, $.shrU($.add(k.G("opt_len"), k.i(10)), k.i(3)));
        k.put(STAT, $.shrU($.add(k.G("static_len"), k.i(10)), k.i(3)));
        k.if($.either($.leU(k.l(STAT), k.l(OPT)), $.eq(k.G("strategy"), k.i(Z_FIXED))), () => k.put(OPT, k.l(STAT)));
      }, () => {
        k.put(OPT, $.add(k.l(LEN), k.i(5)));
        k.put(STAT, k.l(OPT));
      });
      k.if($.both($.leU($.add(k.l(LEN), k.i(4)), k.l(OPT)), $.ne(k.l(BUF), k.i(-1))), () => {
        $.run(this.storedBlockFn(), k.l(BUF), k.l(LEN), k.l(LAST));
      }, () => {
        k.if($.eq(k.l(STAT), k.l(OPT)), () => {
          $.run(this.sendBitsFn(), $.add(k.i(2), k.l(LAST)), k.i(3));
          $.run(this.compressBlockFn(), k.i(D.SLTREE), k.i(D.SDTREE));
        }, () => {
          $.run(this.sendBitsFn(), $.add(k.i(4), k.l(LAST)), k.i(3));
          $.run(this.sendAllTreesFn(), $.add(k.G("l_max"), k.i(1)), $.add(k.G("d_max"), k.i(1)), $.add(k.l(MB), k.i(1)));
          $.run(this.compressBlockFn(), k.i(D.LTREE), k.i(D.DTREE));
        });
      });
      $.run(this.initBlockFn());
      k.if($.ne(k.l(LAST), k.i(0)), () => $.run(this.biWindupFn()));
    });
  }

  /** _tr_tally_lit(c) -> flush */
  private tallyLitFn(): number {
    return this.fn("tally_lit", [I32], [I32], (k) => {
      const $ = k.$;
      k.s16(D_BUF, k.G("sym_next"), k.i(0));
      k.s8(L_BUF, k.G("sym_next"), k.l(0));
      k.inc("sym_next", k.i(1));
      k.setFc(k.i(D.LTREE), k.l(0), $.add(k.fc(k.i(D.LTREE), k.l(0)), k.i(1)));
      k.ret($.eq(k.G("sym_next"), k.i(SYM_END)));
    });
  }

  /** _tr_tally_dist(distance, length) -> flush */
  private tallyDistFn(): number {
    return this.fn("tally_dist", [I32, I32], [I32], (k) => {
      const [DIST, LEN] = [0, 1];
      const $ = k.$;
      const IX = k.local();
      k.s16(D_BUF, k.G("sym_next"), k.l(DIST));
      k.s8(L_BUF, k.G("sym_next"), k.l(LEN));
      k.inc("sym_next", k.i(1));
      k.put(DIST, $.sub($.and(k.l(DIST), k.i(0xffff)), k.i(1)));
      k.put(IX, $.add(k.m8(D.LENCODE, $.and(k.l(LEN), k.i(0xff))), k.i(LITERALS + 1)));
      k.setFc(k.i(D.LTREE), k.l(IX), $.add(k.fc(k.i(D.LTREE), k.l(IX)), k.i(1)));
      k.put(IX, this.dCode(k, $.and(k.l(DIST), k.i(0xffff))));
      k.setFc(k.i(D.DTREE), k.l(IX), $.add(k.fc(k.i(D.DTREE), k.l(IX)), k.i(1)));
      k.ret($.eq(k.G("sym_next"), k.i(SYM_END)));
    });
  }

  /** FLUSH_BLOCK_ONLY(s, last) */
  private flushBlockOnly(k: K, last: X): void {
    const $ = k.$;
    $.run(this.flushBlockFn(),
      $.sel(I32, $.ge(k.G("block_start"), k.i(0)), $.add(k.i(D.WIN), k.G("block_start")), k.i(-1)),
      $.sub(k.G("strstart"), k.G("block_start")),
      last);
    k.S("block_start", k.G("strstart"));
    $.run(this.flushPendingFn());
  }

  /** FLUSH_BLOCK(s, last): returns from the compress function when the
   * output filled. */
  private flushBlock(k: K, last: number): void {
    this.flushBlockOnly(k, k.i(last));
    k.if(k.$.eq(k.G("avail_out"), k.i(0)), () => k.ret(k.i(last ? FINISH_STARTED : NEED_MORE)));
  }

  /** deflate_stored(flush) -> block_state */
  private deflateStoredFn(): number {
    return this.fn("deflate_stored", [I32], [I32], (k) => {
      const FLUSH = 0;
      const $ = k.$;
      const MINB = k.local();
      const LEN = k.local();
      const LEFT = k.local();
      const HAVE = k.local();
      const LAST = k.local();
      const USED = k.local();
      const min = (a: X, b: X): X => $.sel(I32, $.gtU(a, b), b, a);
      const copyOut = (src: X, n: X): void => {
        // window bytes → the output array at next_out
        const J = k.local();
        k.for(J, k.i(0), n, () => {
          $.aset(this.B, $.g(this.OUT), $.add(k.G("next_out"), k.l(J)), k.m8(0, $.add(src, k.l(J))));
        });
      };
      const inToWin = (dst: X, srcIdx: X, n: X): void => {
        const J = k.local();
        k.for(J, k.i(0), n, () => {
          k.s8(D.WIN, $.add(dst, k.l(J)), $.agetU(this.B, $.g(this.IN), $.add(srcIdx, k.l(J))));
        });
      };
      k.put(MINB, min(k.i(PENDING_BUF_SIZE - 5), k.i(W_SIZE)));
      k.put(USED, k.G("avail_in"));
      k.doWhile((brk) => {
        k.put(LEN, k.i(65535));
        k.put(HAVE, $.shrU($.add(k.G("bi_valid"), k.i(42)), k.i(3)));
        k.brIf(brk, $.ltU(k.G("avail_out"), k.l(HAVE)));
        k.put(HAVE, $.sub(k.G("avail_out"), k.l(HAVE)));
        k.put(LEFT, $.sub(k.G("strstart"), k.G("block_start")));
        k.if($.gtU(k.l(LEN), $.add(k.l(LEFT), k.G("avail_in"))), () => k.put(LEN, $.add(k.l(LEFT), k.G("avail_in"))));
        k.if($.gtU(k.l(LEN), k.l(HAVE)), () => k.put(LEN, k.l(HAVE)));
        k.brIf(brk, $.andThen($.ltU(k.l(LEN), k.l(MINB)),
          $.orElse($.orElse($.andThen($.eq(k.l(LEN), k.i(0)), $.ne(k.l(FLUSH), k.i(Z_FINISH))), $.eq(k.l(FLUSH), k.i(Z_NO_FLUSH))),
            $.ne(k.l(LEN), $.add(k.l(LEFT), k.G("avail_in"))))));
        k.put(LAST, $.both($.eq(k.l(FLUSH), k.i(Z_FINISH)), $.eq(k.l(LEN), $.add(k.l(LEFT), k.G("avail_in")))));
        $.run(this.storedBlockFn(), k.i(-1), k.i(0), k.l(LAST));
        k.s8(D.PEND, $.sub(k.G("pending"), k.i(4)), $.and(k.l(LEN), k.i(0xff)));
        k.s8(D.PEND, $.sub(k.G("pending"), k.i(3)), $.and($.shrU(k.l(LEN), k.i(8)), k.i(0xff)));
        k.s8(D.PEND, $.sub(k.G("pending"), k.i(2)), $.and($.xor(k.l(LEN), k.i(-1)), k.i(0xff)));
        k.s8(D.PEND, $.sub(k.G("pending"), k.i(1)), $.and($.shrU($.xor(k.l(LEN), k.i(-1)), k.i(8)), k.i(0xff)));
        $.run(this.flushPendingFn());
        k.if($.ne(k.l(LEFT), k.i(0)), () => {
          k.if($.gtU(k.l(LEFT), k.l(LEN)), () => k.put(LEFT, k.l(LEN)));
          copyOut($.add(k.i(D.WIN), k.G("block_start")), k.l(LEFT));
          k.inc("next_out", k.l(LEFT));
          k.dec("avail_out", k.l(LEFT));
          k.inc("total_out", k.l(LEFT));
          k.inc("block_start", k.l(LEFT));
          k.put(LEN, $.sub(k.l(LEN), k.l(LEFT)));
        });
        k.if($.ne(k.l(LEN), k.i(0)), () => {
          $.run(this.readBufOutFn(), k.l(LEN));
          k.inc("next_out", k.l(LEN));
          k.dec("avail_out", k.l(LEN));
          k.inc("total_out", k.l(LEN));
        });
      }, $.eq(k.l(LAST), k.i(0)));
      k.put(USED, $.sub(k.l(USED), k.G("avail_in")));
      k.if($.ne(k.l(USED), k.i(0)), () => {
        k.if($.geU(k.l(USED), k.i(W_SIZE)), () => {
          k.S("matches", k.i(2));
          inToWin(k.i(0), $.sub(k.G("next_in"), k.i(W_SIZE)), k.i(W_SIZE));
          k.S("strstart", k.i(W_SIZE));
          k.S("insert", k.G("strstart"));
        }, () => {
          k.if($.leU($.sub(k.i(WINDOW_SIZE), k.G("strstart")), k.l(USED)), () => {
            k.dec("strstart", k.i(W_SIZE));
            k.abs(D.WIN)();
            k.abs(D.WIN + W_SIZE)();
            k.G("strstart")();
            k.c.memoryCopy();
            k.if($.lt(k.G("matches"), k.i(2)), () => k.inc("matches", k.i(1)));
            k.if($.gtU(k.G("insert"), k.G("strstart")), () => k.S("insert", k.G("strstart")));
          });
          inToWin(k.G("strstart"), $.sub(k.G("next_in"), k.l(USED)), k.l(USED));
          k.inc("strstart", k.l(USED));
          k.inc("insert", min(k.l(USED), $.sub(k.i(W_SIZE), k.G("insert"))));
        });
        k.S("block_start", k.G("strstart"));
      });
      k.if($.ltU(k.G("high_water"), k.G("strstart")), () => k.S("high_water", k.G("strstart")));
      k.if($.ne(k.l(LAST), k.i(0)), () => k.ret(k.i(FINISH_DONE)));
      // (flush != Z_NO_FLUSH && flush != Z_FINISH && ...) → block_done:
      // deflateSync only ever finishes
      k.put(HAVE, $.sub(k.i(WINDOW_SIZE), k.G("strstart")));
      k.if($.both($.gtU(k.G("avail_in"), k.l(HAVE)), $.ge(k.G("block_start"), k.i(W_SIZE))), () => {
        k.dec("block_start", k.i(W_SIZE));
        k.dec("strstart", k.i(W_SIZE));
        k.abs(D.WIN)();
        k.abs(D.WIN + W_SIZE)();
        k.G("strstart")();
        k.c.memoryCopy();
        k.if($.lt(k.G("matches"), k.i(2)), () => k.inc("matches", k.i(1)));
        k.put(HAVE, $.add(k.l(HAVE), k.i(W_SIZE)));
        k.if($.gtU(k.G("insert"), k.G("strstart")), () => k.S("insert", k.G("strstart")));
      });
      k.if($.gtU(k.l(HAVE), k.G("avail_in")), () => k.put(HAVE, k.G("avail_in")));
      k.if($.ne(k.l(HAVE), k.i(0)), () => {
        $.drop($.call(this.readBufFn(), $.add(k.i(D.WIN), k.G("strstart")), k.l(HAVE)));
        k.inc("strstart", k.l(HAVE));
        k.inc("insert", min(k.l(HAVE), $.sub(k.i(W_SIZE), k.G("insert"))));
      });
      k.if($.ltU(k.G("high_water"), k.G("strstart")), () => k.S("high_water", k.G("strstart")));
      k.put(HAVE, $.shrU($.add(k.G("bi_valid"), k.i(42)), k.i(3)));
      k.put(HAVE, min($.sub(k.i(PENDING_BUF_SIZE), k.l(HAVE)), k.i(65535)));
      k.put(MINB, min(k.l(HAVE), k.i(W_SIZE)));
      k.put(LEFT, $.sub(k.G("strstart"), k.G("block_start")));
      k.if($.orElse($.geU(k.l(LEFT), k.l(MINB)),
        $.andThen($.andThen($.andThen($.either($.ne(k.l(LEFT), k.i(0)), $.eq(k.l(FLUSH), k.i(Z_FINISH))), $.ne(k.l(FLUSH), k.i(Z_NO_FLUSH))),
          $.eq(k.G("avail_in"), k.i(0))), $.leU(k.l(LEFT), k.l(HAVE)))), () => {
        k.put(LEN, min(k.l(LEFT), k.l(HAVE)));
        k.put(LAST, $.both($.both($.eq(k.l(FLUSH), k.i(Z_FINISH)), $.eq(k.G("avail_in"), k.i(0))), $.eq(k.l(LEN), k.l(LEFT))));
        $.run(this.storedBlockFn(), $.add(k.i(D.WIN), k.G("block_start")), k.l(LEN), k.l(LAST));
        k.inc("block_start", k.l(LEN));
        $.run(this.flushPendingFn());
      });
      k.ret($.sel(I32, $.ne(k.l(LAST), k.i(0)), k.i(FINISH_STARTED), k.i(NEED_MORE)));
    });
  }

  /** deflate_fast(flush) -> block_state (levels 1-3) */
  private deflateFastFn(): number {
    return this.fn("deflate_fast", [I32], [I32], (k) => {
      const FLUSH = 0;
      const $ = k.$;
      const HH = k.local();
      const BF = k.local();
      k.forever((brk) => {
        k.if($.ltU(k.G("lookahead"), k.i(MIN_LOOKAHEAD)), () => {
          $.run(this.fillWindowFn());
          k.if($.both($.ltU(k.G("lookahead"), k.i(MIN_LOOKAHEAD)), $.eq(k.l(FLUSH), k.i(Z_NO_FLUSH))), () => k.ret(k.i(NEED_MORE)));
          k.brIf(brk, $.eq(k.G("lookahead"), k.i(0)));
        });
        k.put(HH, k.i(0));
        k.if($.geU(k.G("lookahead"), k.i(MIN_MATCH)), () => k.put(HH, $.call(this.insertStringFn(), k.G("strstart"))));
        k.if($.andThen($.ne(k.l(HH), k.i(0)), $.leU($.sub(k.G("strstart"), k.l(HH)), k.i(MAX_DIST))), () => {
          k.S("match_length", $.call(this.longestMatchFn(), k.l(HH)));
        });
        k.if($.geU(k.G("match_length"), k.i(MIN_MATCH)), () => {
          k.put(BF, $.call(this.tallyDistFn(), $.sub(k.G("strstart"), k.G("match_start")), $.sub(k.G("match_length"), k.i(MIN_MATCH))));
          k.dec("lookahead", k.G("match_length"));
          k.if($.both($.leU(k.G("match_length"), k.G("max_lazy")), $.geU(k.G("lookahead"), k.i(MIN_MATCH))), () => {
            k.dec("match_length", k.i(1));
            k.doWhile(() => {
              k.inc("strstart", k.i(1));
              k.put(HH, $.call(this.insertStringFn(), k.G("strstart")));
              k.dec("match_length", k.i(1));
            }, $.ne(k.G("match_length"), k.i(0)));
            k.inc("strstart", k.i(1));
          }, () => {
            k.inc("strstart", k.G("match_length"));
            k.S("match_length", k.i(0));
            // the Chromium hash needs no ins_h refresh here
          });
        }, () => {
          k.put(BF, $.call(this.tallyLitFn(), k.m8(D.WIN, k.G("strstart"))));
          k.dec("lookahead", k.i(1));
          k.inc("strstart", k.i(1));
        });
        k.if($.ne(k.l(BF), k.i(0)), () => this.flushBlock(k, 0));
      });
      k.S("insert", $.sel(I32, $.ltU(k.G("strstart"), k.i(MIN_MATCH - 1)), k.G("strstart"), k.i(MIN_MATCH - 1)));
      k.if($.eq(k.l(FLUSH), k.i(Z_FINISH)), () => {
        this.flushBlock(k, 1);
        k.ret(k.i(FINISH_DONE));
      });
      k.if($.ne(k.G("sym_next"), k.i(0)), () => this.flushBlock(k, 0));
      k.ret(k.i(1)); // block_done
    });
  }

  /** deflate_slow(flush) -> block_state (levels 4-9) */
  private deflateSlowFn(): number {
    return this.fn("deflate_slow", [I32], [I32], (k) => {
      const FLUSH = 0;
      const $ = k.$;
      const HH = k.local();
      const BF = k.local();
      const MAXI = k.local();
      k.forever((brk) => {
        k.if($.ltU(k.G("lookahead"), k.i(MIN_LOOKAHEAD)), () => {
          $.run(this.fillWindowFn());
          k.if($.both($.ltU(k.G("lookahead"), k.i(MIN_LOOKAHEAD)), $.eq(k.l(FLUSH), k.i(Z_NO_FLUSH))), () => k.ret(k.i(NEED_MORE)));
          k.brIf(brk, $.eq(k.G("lookahead"), k.i(0)));
        });
        k.put(HH, k.i(0));
        k.if($.geU(k.G("lookahead"), k.i(MIN_MATCH)), () => k.put(HH, $.call(this.insertStringFn(), k.G("strstart"))));
        k.S("prev_length", k.G("match_length"));
        k.S("prev_match", k.G("match_start"));
        k.S("match_length", k.i(MIN_MATCH - 1));
        k.if($.andThen($.andThen($.ne(k.l(HH), k.i(0)), $.ltU(k.G("prev_length"), k.G("max_lazy"))),
          $.leU($.sub(k.G("strstart"), k.l(HH)), k.i(MAX_DIST))), () => {
          k.S("match_length", $.call(this.longestMatchFn(), k.l(HH)));
          // strategy is Z_DEFAULT_STRATEGY: only the TOO_FAR rule
          k.if($.both($.leU(k.G("match_length"), k.i(5)),
            $.both($.eq(k.G("match_length"), k.i(MIN_MATCH)), $.gtU($.sub(k.G("strstart"), k.G("match_start")), k.i(TOO_FAR)))), () => {
            k.S("match_length", k.i(MIN_MATCH - 1));
          });
        });
        k.if($.both($.geU(k.G("prev_length"), k.i(MIN_MATCH)), $.leU(k.G("match_length"), k.G("prev_length"))), () => {
          k.put(MAXI, $.sub($.add(k.G("strstart"), k.G("lookahead")), k.i(MIN_MATCH)));
          k.put(BF, $.call(this.tallyDistFn(), $.sub($.sub(k.G("strstart"), k.i(1)), k.G("prev_match")), $.sub(k.G("prev_length"), k.i(MIN_MATCH))));
          k.dec("lookahead", $.sub(k.G("prev_length"), k.i(1)));
          k.dec("prev_length", k.i(2));
          k.doWhile(() => {
            k.inc("strstart", k.i(1));
            k.if($.leU(k.G("strstart"), k.l(MAXI)), () => k.put(HH, $.call(this.insertStringFn(), k.G("strstart"))));
            k.dec("prev_length", k.i(1));
          }, $.ne(k.G("prev_length"), k.i(0)));
          k.S("match_available", k.i(0));
          k.S("match_length", k.i(MIN_MATCH - 1));
          k.inc("strstart", k.i(1));
          k.if($.ne(k.l(BF), k.i(0)), () => this.flushBlock(k, 0));
        }, () => {
          k.if($.ne(k.G("match_available"), k.i(0)), () => {
            k.put(BF, $.call(this.tallyLitFn(), k.m8(D.WIN, $.sub(k.G("strstart"), k.i(1)))));
            k.if($.ne(k.l(BF), k.i(0)), () => this.flushBlockOnly(k, k.i(0)));
            k.inc("strstart", k.i(1));
            k.dec("lookahead", k.i(1));
            k.if($.eq(k.G("avail_out"), k.i(0)), () => k.ret(k.i(NEED_MORE)));
          }, () => {
            k.S("match_available", k.i(1));
            k.inc("strstart", k.i(1));
            k.dec("lookahead", k.i(1));
          });
        });
      });
      k.if($.ne(k.G("match_available"), k.i(0)), () => {
        $.drop($.call(this.tallyLitFn(), k.m8(D.WIN, $.sub(k.G("strstart"), k.i(1)))));
        k.S("match_available", k.i(0));
      });
      k.S("insert", $.sel(I32, $.ltU(k.G("strstart"), k.i(MIN_MATCH - 1)), k.G("strstart"), k.i(MIN_MATCH - 1)));
      k.if($.eq(k.l(FLUSH), k.i(Z_FINISH)), () => {
        this.flushBlock(k, 1);
        k.ret(k.i(FINISH_DONE));
      });
      k.if($.ne(k.G("sym_next"), k.i(0)), () => this.flushBlock(k, 0));
      k.ret(k.i(1)); // block_done
    });
  }

  /** putShortMSB */
  private putShortMsb(k: K, v: X): void {
    const $ = k.$;
    $.run(this.putByteFn(), $.and($.shrU(v, k.i(8)), k.i(0xff)));
    $.run(this.putByteFn(), $.and(v, k.i(0xff)));
  }

  /** deflate(strm, flush) for flush = Z_FINISH, a zlib wrapper, no
   * dictionary -> Z_OK | Z_STREAM_END | Z_BUF_ERROR */
  private deflateCallFn(): number {
    return this.fn("deflate", [I32], [I32], (k) => {
      const FLUSH = 0;
      const $ = k.$;
      const HDR = k.local();
      const LF = k.local();
      const BS = k.local();
      k.if($.eq(k.G("avail_out"), k.i(0)), () => k.ret(k.i(Z_BUF_ERROR)));
      // old_flush only feeds the RANK test below, which Z_FINISH skips
      k.S("last_flush", k.l(FLUSH));
      k.if($.ne(k.G("pending"), k.i(0)), () => {
        $.run(this.flushPendingFn());
        k.if($.eq(k.G("avail_out"), k.i(0)), () => {
          k.S("last_flush", k.i(-1));
          k.ret(k.i(Z_OK));
        });
      });
      // (avail_in == 0 && RANK(flush) <= RANK(old_flush) && flush !=
      // Z_FINISH) never holds for Z_FINISH
      k.if($.both($.eq(k.G("status"), k.i(FINISH_STATE)), $.ne(k.G("avail_in"), k.i(0))), () => k.ret(k.i(Z_BUF_ERROR)));
      k.if($.eq(k.G("status"), k.i(INIT_STATE)), () => {
        // header = (Z_DEFLATED + ((w_bits - 8) << 4)) << 8, w_bits 15
        k.put(HDR, k.i((8 + ((15 - 8) << 4)) << 8));
        k.put(LF, $.sel(I32, $.lt(k.G("level"), k.i(2)), k.i(0),
          $.sel(I32, $.lt(k.G("level"), k.i(6)), k.i(1), $.sel(I32, $.eq(k.G("level"), k.i(6)), k.i(2), k.i(3)))));
        k.put(HDR, $.or(k.l(HDR), $.shl(k.l(LF), k.i(6))));
        // strstart is 0: no PRESET_DICT
        k.put(HDR, $.add(k.l(HDR), $.sub(k.i(31), $.raw((c) => {
          c.localGet(HDR);
          c.i32Const(31);
          c.i32RemU();
        }))));
        this.putShortMsb(k, k.l(HDR));
        k.S("adler", k.i(1));
        k.S("status", k.i(BUSY_STATE));
        $.run(this.flushPendingFn());
        k.if($.ne(k.G("pending"), k.i(0)), () => {
          k.S("last_flush", k.i(-1));
          k.ret(k.i(Z_OK));
        });
      });
      k.if($.orElse($.orElse($.ne(k.G("avail_in"), k.i(0)), $.ne(k.G("lookahead"), k.i(0))),
        $.both($.ne(k.l(FLUSH), k.i(Z_NO_FLUSH)), $.ne(k.G("status"), k.i(FINISH_STATE)))), () => {
        k.put(BS, $.sel(I32, $.eq(k.G("level"), k.i(0)), $.call(this.deflateStoredFn(), k.l(FLUSH)),
          $.sel(I32, $.le(k.G("level"), k.i(3)), $.call(this.deflateFastFn(), k.l(FLUSH)), $.call(this.deflateSlowFn(), k.l(FLUSH)))));
        k.if($.either($.eq(k.l(BS), k.i(FINISH_STARTED)), $.eq(k.l(BS), k.i(FINISH_DONE))), () => k.S("status", k.i(FINISH_STATE)));
        k.if($.either($.eq(k.l(BS), k.i(NEED_MORE)), $.eq(k.l(BS), k.i(FINISH_STARTED))), () => {
          k.if($.eq(k.G("avail_out"), k.i(0)), () => k.S("last_flush", k.i(-1)));
          k.ret(k.i(Z_OK));
        });
        // block_done is never answered for Z_FINISH
      });
      k.if($.le(k.G("wrap"), k.i(0)), () => k.ret(k.i(Z_STREAM_END)));
      this.putShortMsb(k, $.shrU(k.G("adler"), k.i(16)));
      this.putShortMsb(k, $.and(k.G("adler"), k.i(0xffff)));
      $.run(this.flushPendingFn());
      k.S("wrap", $.sub(k.i(0), k.G("wrap")));
      k.ret($.sel(I32, $.ne(k.G("pending"), k.i(0)), k.i(Z_OK), k.i(Z_STREAM_END)));
    });
  }

  /** `(bytes<u8>, level) -> bytes<u8>` — zlib.deflateSync(data, {level}):
   * deflateInit2 + Node's processChunkSync. level -1 is 6. */
  deflateSyncFn(): number {
    return this.fn("deflateSync", [this.btRef, I32], [this.btRef], (k) => {
      const [DATA, LEVEL] = [0, 1];
      const $ = k.$;
      const POS = k.local();
      const CAP = k.local();
      const NB = k.local(this.bRef);
      const RET = k.local();
      const R = k.local(this.bRef);
      this.enterArea(k, deflateBlob(), D.SLTREE, "d");
      k.if($.eq(k.l(LEVEL), k.i(-1)), () => k.put(LEVEL, k.i(6)));
      // deflateInit2_: the zeroed window and prev
      this.zero(k, D.WIN, (W_SIZE + WINDOW_PADDING) * 2);
      this.zero(k, D.PREV, W_SIZE * 2);
      k.S("level", k.l(LEVEL));
      k.S("strategy", k.i(0));
      k.S("high_water", k.i(0));
      // deflateResetKeep
      k.S("total_in", k.i(0));
      k.S("total_out", k.i(0));
      k.S("pending", k.i(0));
      k.S("pend_out", k.i(0));
      k.S("wrap", k.i(1));
      k.S("status", k.i(INIT_STATE));
      k.S("adler", k.i(1));
      k.S("last_flush", k.i(-2));
      // _tr_init
      k.S("bi_buf", k.i(0));
      k.S("bi_valid", k.i(0));
      $.run(this.initBlockFn());
      // lm_init: CLEAR_HASH and the configuration row
      this.zero(k, D.HEAD, HASH_SIZE * 2);
      k.S("max_lazy", k.m16(D.CONFIG + 2, k.l(LEVEL), 3));
      k.S("good_match", k.m16(D.CONFIG, k.l(LEVEL), 3));
      k.S("nice_match", k.m16(D.CONFIG + 4, k.l(LEVEL), 3));
      k.S("max_chain", k.m16(D.CONFIG + 6, k.l(LEVEL), 3));
      k.S("strstart", k.i(0));
      k.S("block_start", k.i(0));
      k.S("lookahead", k.i(0));
      k.S("insert", k.i(0));
      k.S("match_length", k.i(MIN_MATCH - 1));
      k.S("prev_length", k.i(MIN_MATCH - 1));
      k.S("match_available", k.i(0));
      k.S("match_start", k.i(0));
      k.S("prev_match", k.i(0));
      k.S("ins_h", k.i(0));
      // the stream
      $.gput(this.IN, $.get(this.BT, 0, k.l(DATA)));
      k.S("next_in", $.get(this.BT, 1, k.l(DATA)));
      k.S("avail_in", $.get(this.BT, 2, k.l(DATA)));
      k.put(CAP, k.i(CHUNK));
      $.gput(this.OUT, $.anew(this.B, k.l(CAP)));
      // processChunkSync: Z_FINISH with a fresh chunk while one fills
      k.forever((brk) => {
        k.if($.gtU($.add(k.l(POS), k.i(CHUNK)), k.l(CAP)), () => {
          k.put(CAP, $.shl(k.l(CAP), k.i(1)));
          k.put(NB, $.anew(this.B, k.l(CAP)));
          $.do(k.l(NB), k.i(0), $.g(this.OUT), k.i(0), k.l(POS));
          k.c.arrayCopy(this.B, this.B);
          $.gput(this.OUT, k.l(NB));
        });
        k.S("next_out", k.l(POS));
        k.S("avail_out", k.i(CHUNK));
        k.put(RET, $.call(this.deflateCallFn(), k.i(Z_FINISH)));
        k.put(POS, k.G("next_out"));
        k.brIf(brk, $.ne(k.G("avail_out"), k.i(0)));
      });
      // Node throws for anything but Z_STREAM_END here; deflate never
      // answers that for a whole buffer
      k.if($.ne(k.l(RET), k.i(Z_STREAM_END)), () => k.$.trap());
      k.put(R, $.anew(this.B, k.l(POS)));
      $.do(k.l(R), k.i(0), $.g(this.OUT), k.i(0), k.l(POS));
      k.c.arrayCopy(this.B, this.B);
      $.gput(this.IN, $.nul(this.B));
      $.gput(this.OUT, $.nul(this.B));
      k.ret($.new_(this.BT, $.raw((c) => {
        c.localGet(R);
        c.refAsNonNull();
      }), k.i(0), k.l(POS)));
    });
  }

  /* ══ inflate ═══════════════════════════════════════════════════════ */

  /** inflate_table(type, lens (area offset), codes, table (area offset),
   * bits) -> 0 | -1 | 1; the table's end and the root bits land in the
   * globals t_next / t_bits. */
  private inflateTableFn(): number {
    return this.fn("inflate_table", [I32, I32, I32, I32, I32], [I32], (k) => {
      const [TYPE, LENSP, NCODES, TABLE, BITSIN] = [0, 1, 2, 3, 4];
      const $ = k.$;
      const LEN = k.local();
      const SYM = k.local();
      const MIN = k.local();
      const MAX = k.local();
      const ROOT = k.local();
      const CURR = k.local();
      const DROP = k.local();
      const LEFT = k.local();
      const USED = k.local();
      const HUFF = k.local();
      const INCR = k.local();
      const FILL = k.local();
      const LOW = k.local();
      const MASK = k.local();
      const HERE = k.local();
      const NEXT = k.local();
      const BASE = k.local();
      const EXTRA = k.local();
      const MATCH = k.local();
      const WS = k.local();
      const count = (i: X): X => k.m16(I.COUNT, i);
      const lens = (i: X): X => k.m16(0, $.add(k.l(LENSP), $.shl(i, k.i(1))), 0);
      const work = (i: X): X => k.m16(I.WORK, i);
      const entry = (op: X, bits: X, val: X): X => $.or($.or(op, $.shl(bits, k.i(8))), $.shl(val, k.i(16)));
      const putEntry = (idx: X, v: X): void => k.s32(0, $.add(k.l(NEXT), $.shl(idx, k.i(2))), v, 0);
      k.for(LEN, k.i(0), k.i(16), () => k.s16(I.COUNT, k.l(LEN), k.i(0)));
      k.for(SYM, k.i(0), k.l(NCODES), () => {
        k.s16(I.COUNT, lens(k.l(SYM)), $.add(count(lens(k.l(SYM))), k.i(1)));
      });
      k.put(ROOT, k.l(BITSIN));
      k.put(MAX, k.i(15));
      k.while($.ge(k.l(MAX), k.i(1)), (brk) => {
        k.brIf(brk, $.ne(count(k.l(MAX)), k.i(0)));
        k.put(MAX, $.sub(k.l(MAX), k.i(1)));
      });
      k.if($.gtU(k.l(ROOT), k.l(MAX)), () => k.put(ROOT, k.l(MAX)));
      k.if($.eq(k.l(MAX), k.i(0)), () => {
        // no symbols: a table that forces an error when decoded
        k.s32(0, k.l(TABLE), k.i(0x140), 0); // op 64, bits 1, val 0
        k.s32(4, k.l(TABLE), k.i(0x140), 0);
        k.S("t_next", $.add(k.l(TABLE), k.i(8)));
        k.S("t_bits", k.i(1));
        k.ret(k.i(0));
      });
      k.put(MIN, k.i(1));
      k.while($.ltU(k.l(MIN), k.l(MAX)), (brk) => {
        k.brIf(brk, $.ne(count(k.l(MIN)), k.i(0)));
        k.put(MIN, $.add(k.l(MIN), k.i(1)));
      });
      k.if($.ltU(k.l(ROOT), k.l(MIN)), () => k.put(ROOT, k.l(MIN)));
      // over-subscribed or incomplete
      k.put(LEFT, k.i(1));
      k.for(LEN, k.i(1), k.i(16), () => {
        k.put(LEFT, $.shl(k.l(LEFT), k.i(1)));
        k.put(LEFT, $.sub(k.l(LEFT), count(k.l(LEN))));
        k.if($.lt(k.l(LEFT), k.i(0)), () => k.ret(k.i(-1)));
      });
      k.if($.both($.gt(k.l(LEFT), k.i(0)), $.either($.eq(k.l(TYPE), k.i(CODES)), $.ne(k.l(MAX), k.i(1)))), () => k.ret(k.i(-1)));
      k.s16(I.OFFS + 2, null, k.i(0));
      k.for(LEN, k.i(1), k.i(15), () => {
        k.s16(I.OFFS, $.add(k.l(LEN), k.i(1)), $.add(k.m16(I.OFFS, k.l(LEN)), count(k.l(LEN))));
      });
      k.for(SYM, k.i(0), k.l(NCODES), () => {
        k.if($.ne(lens(k.l(SYM)), k.i(0)), () => {
          k.put(WS, k.m16(I.OFFS, lens(k.l(SYM))));
          k.s16(I.WORK, k.l(WS), k.l(SYM));
          k.s16(I.OFFS, lens(k.l(SYM)), $.add(k.l(WS), k.i(1)));
        });
      });
      k.if($.eq(k.l(TYPE), k.i(CODES)), () => {
        k.put(BASE, k.i(I.WORK));
        k.put(EXTRA, k.i(I.WORK));
        k.put(MATCH, k.i(20));
      }, () => {
        k.if($.eq(k.l(TYPE), k.i(LENS)), () => {
          k.put(BASE, k.i(I.LBASE));
          k.put(EXTRA, k.i(I.LEXT));
          k.put(MATCH, k.i(257));
        }, () => {
          k.put(BASE, k.i(I.DBASE));
          k.put(EXTRA, k.i(I.DEXT));
          k.put(MATCH, k.i(0));
        });
      });
      k.put(HUFF, k.i(0));
      k.put(SYM, k.i(0));
      k.put(LEN, k.l(MIN));
      k.put(NEXT, k.l(TABLE));
      k.put(CURR, k.l(ROOT));
      k.put(DROP, k.i(0));
      k.put(LOW, k.i(-1));
      k.put(USED, $.shl(k.i(1), k.l(ROOT)));
      k.put(MASK, $.sub(k.l(USED), k.i(1)));
      const tooBig = (): X => $.either($.both($.eq(k.l(TYPE), k.i(LENS)), $.gtU(k.l(USED), k.i(ENOUGH_LENS))),
        $.both($.eq(k.l(TYPE), k.i(DISTS)), $.gtU(k.l(USED), k.i(ENOUGH_DISTS))));
      k.if(tooBig(), () => k.ret(k.i(1)));
      const wsym = (): X => work(k.l(SYM));
      k.forever((brk) => {
        // create table entry
        k.if($.ltU($.add(wsym(), k.i(1)), k.l(MATCH)), () => {
          k.put(HERE, entry(k.i(0), $.sub(k.l(LEN), k.l(DROP)), wsym()));
        }, () => {
          k.if($.geU(wsym(), k.l(MATCH)), () => {
            const idx = (): X => $.shl($.sub(wsym(), k.l(MATCH)), k.i(1));
            k.put(HERE, entry($.and(k.m16(0, $.add(k.l(EXTRA), idx()), 0), k.i(0xff)), $.sub(k.l(LEN), k.l(DROP)), k.m16(0, $.add(k.l(BASE), idx()), 0)));
          }, () => {
            k.put(HERE, entry(k.i(32 + 64), $.sub(k.l(LEN), k.l(DROP)), k.i(0)));
          });
        });
        // replicate for indices with low len bits equal to huff
        k.put(INCR, $.shl(k.i(1), $.sub(k.l(LEN), k.l(DROP))));
        k.put(FILL, $.shl(k.i(1), k.l(CURR)));
        k.put(MIN, k.l(FILL));
        k.doWhile(() => {
          k.put(FILL, $.sub(k.l(FILL), k.l(INCR)));
          putEntry($.add($.shrU(k.l(HUFF), k.l(DROP)), k.l(FILL)), k.l(HERE));
        }, $.ne(k.l(FILL), k.i(0)));
        // backwards increment the len-bit code huff
        k.put(INCR, $.shl(k.i(1), $.sub(k.l(LEN), k.i(1))));
        k.while($.ne($.and(k.l(HUFF), k.l(INCR)), k.i(0)), () => k.put(INCR, $.shrU(k.l(INCR), k.i(1))));
        k.if($.ne(k.l(INCR), k.i(0)), () => {
          k.put(HUFF, $.and(k.l(HUFF), $.sub(k.l(INCR), k.i(1))));
          k.put(HUFF, $.add(k.l(HUFF), k.l(INCR)));
        }, () => k.put(HUFF, k.i(0)));
        // next symbol
        k.put(SYM, $.add(k.l(SYM), k.i(1)));
        k.s16(I.COUNT, k.l(LEN), $.sub(count(k.l(LEN)), k.i(1)));
        k.if($.eq(count(k.l(LEN)), k.i(0)), () => {
          k.brIf(brk, $.eq(k.l(LEN), k.l(MAX)));
          k.put(LEN, lens(work(k.l(SYM))));
        });
        // a new sub-table when needed
        k.if($.both($.gtU(k.l(LEN), k.l(ROOT)), $.ne($.and(k.l(HUFF), k.l(MASK)), k.l(LOW))), () => {
          k.if($.eq(k.l(DROP), k.i(0)), () => k.put(DROP, k.l(ROOT)));
          k.put(NEXT, $.add(k.l(NEXT), $.shl(k.l(MIN), k.i(2))));
          k.put(CURR, $.sub(k.l(LEN), k.l(DROP)));
          k.put(LEFT, $.shl(k.i(1), k.l(CURR)));
          k.while($.ltU($.add(k.l(CURR), k.l(DROP)), k.l(MAX)), (brk2) => {
            k.put(LEFT, $.sub(k.l(LEFT), count($.add(k.l(CURR), k.l(DROP)))));
            k.brIf(brk2, $.le(k.l(LEFT), k.i(0)));
            k.put(CURR, $.add(k.l(CURR), k.i(1)));
            k.put(LEFT, $.shl(k.l(LEFT), k.i(1)));
          });
          k.put(USED, $.add(k.l(USED), $.shl(k.i(1), k.l(CURR))));
          k.if(tooBig(), () => k.ret(k.i(1)));
          k.put(LOW, $.and(k.l(HUFF), k.l(MASK)));
          k.s32(0, $.add(k.l(TABLE), $.shl(k.l(LOW), k.i(2))),
            entry(k.l(CURR), k.l(ROOT), $.shrU($.sub(k.l(NEXT), k.l(TABLE)), k.i(2))), 0);
        });
      });
      // an incomplete code's one remaining entry
      k.if($.ne(k.l(HUFF), k.i(0)), () => putEntry(k.l(HUFF), entry(k.i(64), $.sub(k.l(LEN), k.l(DROP)), k.i(0))));
      k.S("t_next", $.add(k.l(TABLE), $.shl(k.l(USED), k.i(2))));
      k.S("t_bits", k.l(ROOT));
      k.ret(k.i(0));
    });
  }

  /** `(bytes<u8>) -> bytes<u8> | null` — zlib.inflateSync(data): one
   * inflate(Z_FINISH) over the whole input. Null sets errGlobal(). */
  inflateSyncFn(): number {
    return this.fn("inflateSync", [this.btRef], [this.btRef], (k) => {
      const DATA = 0;
      const $ = k.$;
      const c = k.c;
      // the registers
      const NXT = k.local();
      const END = k.local();
      const PUT = k.local();
      const CAP = k.local();
      const HOLD = k.local();
      const BITS = k.local();
      // the state
      const MODE = k.local();
      const LAST = k.local();
      const LENGTH = k.local();
      const OFFSET = k.local();
      const EXTRA = k.local();
      const NLEN = k.local();
      const NDIST = k.local();
      const NCODE = k.local();
      const HAVE = k.local();
      const LENCODE = k.local();
      const DISTCODE = k.local();
      const LENBITS = k.local();
      const DISTBITS = k.local();
      const NEXTT = k.local();
      const FIXED = k.local(); // fixed tables built in this call
      const FLENCODE = k.local();
      const FDISTCODE = k.local();
      const HERE = k.local();
      const LASTC = k.local();
      const LEN = k.local();
      const COPY = k.local();
      const FROM = k.local();
      const J = k.local();
      const NB = k.local(this.bRef);
      const R = k.local(this.bRef);
      this.enterArea(k, inflateBlob(), I.ORDER, "i");
      $.gput(this.IN, $.get(this.BT, 0, k.l(DATA)));
      k.put(NXT, $.get(this.BT, 1, k.l(DATA)));
      k.put(END, $.add(k.l(NXT), $.get(this.BT, 2, k.l(DATA))));
      k.put(CAP, k.i(CHUNK));
      $.gput(this.OUT, $.anew(this.B, k.l(CAP)));
      k.S("%ierr", k.i(0));

      const fail = (id: number): void => {
        k.S("%ierr", k.i(id));
        $.gput(this.IN, $.nul(this.B));
        $.gput(this.OUT, $.nul(this.B));
        k.ret($.nul(this.BT));
      };
      /** room for n more output bytes */
      const room = (n: X): void => {
        k.if($.gtU($.add(k.l(PUT), n), k.l(CAP)), () => {
          k.put(CAP, $.shl(k.l(CAP), k.i(1)));
          k.while($.gtU($.add(k.l(PUT), n), k.l(CAP)), () => k.put(CAP, $.shl(k.l(CAP), k.i(1))));
          k.put(NB, $.anew(this.B, k.l(CAP)));
          $.do(k.l(NB), k.i(0), $.g(this.OUT), k.i(0), k.l(PUT));
          c.arrayCopy(this.B, this.B);
          $.gput(this.OUT, k.l(NB));
        });
      };
      const bitsN = (n: X): X => $.and(k.l(HOLD), $.sub($.shl(k.i(1), n), k.i(1)));
      const drop = (n: X): void => {
        k.put(HOLD, $.shrU(k.l(HOLD), n));
        k.put(BITS, $.sub(k.l(BITS), n));
      };
      const initbits = (): void => {
        k.put(HOLD, k.i(0));
        k.put(BITS, k.i(0));
      };
      const bytebits = (): void => {
        k.put(HOLD, $.shrU(k.l(HOLD), $.and(k.l(BITS), k.i(7))));
        k.put(BITS, $.sub(k.l(BITS), $.and(k.l(BITS), k.i(7))));
      };

      k.block((leave) => {
        const pullbyte = (): void => {
          k.brIf(leave, $.geU(k.l(NXT), k.l(END)));
          k.put(HOLD, $.add(k.l(HOLD), $.shl($.agetU(this.B, $.g(this.IN), k.l(NXT)), k.l(BITS))));
          k.put(NXT, $.add(k.l(NXT), k.i(1)));
          k.put(BITS, $.add(k.l(BITS), k.i(8)));
        };
        const needbits = (n: X): void => {
          k.while($.ltU(k.l(BITS), n), () => pullbyte());
        };
        /** for (;;) { here = tbl[BITS(nbits)]; if (here.bits <= bits)
         * break; PULLBYTE(); } */
        const lookup = (tbl: X, idx: () => X, need: () => X): void => {
          k.forever((brk) => {
            k.put(HERE, k.m32(0, $.add(tbl, $.shl(idx(), k.i(2))), 0));
            k.brIf(brk, $.leU(need(), k.l(BITS)));
            pullbyte();
          });
        };
        const op = (h: number): X => $.and(k.l(h), k.i(0xff));
        const hbits = (h: number): X => $.and($.shrU(k.l(h), k.i(8)), k.i(0xff));
        const val = (h: number): X => $.shrU(k.l(h), k.i(16));

        const M = {
          HEAD: 0, DICTID: 1, DICT: 2, TYPE: 3, TYPEDO: 4, STORED: 5, COPY_: 6, COPY: 7, TABLE: 8, LENLENS: 9, CODELENS: 10,
          LEN_: 11, LEN: 12, LENEXT: 13, DIST: 14, DISTEXT: 15, MATCH: 16, LIT: 17, CHECK: 18, DONE: 19,
        } as const;
        k.put(MODE, k.i(M.HEAD));
        k.loop((top) => {
          const brk = (): void => k.br(top);
          k.switch(k.l(MODE), [
            // HEAD
            () => {
              needbits(k.i(16));
              k.if($.ne($.raw((cc) => {
                $.add($.shl(bitsN(k.i(8)), k.i(8)), $.shrU(k.l(HOLD), k.i(8)))();
                cc.i32Const(31);
                cc.i32RemU();
              }), k.i(0)), () => fail(E.HEADER));
              k.if($.ne(bitsN(k.i(4)), k.i(8)), () => fail(E.METHOD));
              drop(k.i(4));
              k.put(LEN, $.add(bitsN(k.i(4)), k.i(8)));
              k.if($.gtU(k.l(LEN), k.i(15)), () => fail(E.WSIZE));
              k.put(MODE, $.sel(I32, $.ne($.and(k.l(HOLD), k.i(0x200)), k.i(0)), k.i(M.DICTID), k.i(M.TYPE)));
              initbits();
              brk();
            },
            // DICTID
            () => {
              needbits(k.i(32));
              initbits();
              k.put(MODE, k.i(M.DICT));
            },
            // DICT: no dictionary was set
            () => {
              fail(E.DICT);
            },
            // TYPE
            () => {
              k.put(MODE, k.i(M.TYPEDO));
            },
            // TYPEDO
            () => {
              k.if($.ne(k.l(LAST), k.i(0)), () => {
                bytebits();
                k.put(MODE, k.i(M.CHECK));
                brk();
              });
              needbits(k.i(3));
              k.put(LAST, bitsN(k.i(1)));
              drop(k.i(1));
              k.put(LEN, bitsN(k.i(2)));
              k.if($.eq(k.l(LEN), k.i(0)), () => k.put(MODE, k.i(M.STORED)));
              k.if($.eq(k.l(LEN), k.i(1)), () => {
                // fixedtables (BUILDFIXED's construction, once per call)
                k.if($.not(k.l(FIXED)), () => {
                  k.for(J, k.i(0), k.i(288), () => {
                    k.s16(I.FLENS, k.l(J), $.sel(I32, $.lt(k.l(J), k.i(144)), k.i(8),
                      $.sel(I32, $.lt(k.l(J), k.i(256)), k.i(9), $.sel(I32, $.lt(k.l(J), k.i(280)), k.i(7), k.i(8)))));
                  });
                  $.drop($.call(this.inflateTableFn(), k.i(LENS), k.i(I.FLENS), k.i(288), k.i(I.FIXED), k.i(9)));
                  k.put(FDISTCODE, k.G("t_next"));
                  k.for(J, k.i(0), k.i(32), () => k.s16(I.FLENS, k.l(J), k.i(5)));
                  $.drop($.call(this.inflateTableFn(), k.i(DISTS), k.i(I.FLENS), k.i(32), k.l(FDISTCODE), k.i(5)));
                  k.put(FLENCODE, k.i(I.FIXED));
                  k.put(FIXED, k.i(1));
                });
                k.put(LENCODE, k.l(FLENCODE));
                k.put(LENBITS, k.i(9));
                k.put(DISTCODE, k.l(FDISTCODE));
                k.put(DISTBITS, k.i(5));
                k.put(MODE, k.i(M.LEN_));
              });
              k.if($.eq(k.l(LEN), k.i(2)), () => k.put(MODE, k.i(M.TABLE)));
              k.if($.eq(k.l(LEN), k.i(3)), () => fail(E.BTYPE));
              drop(k.i(2));
              brk();
            },
            // STORED
            () => {
              bytebits();
              needbits(k.i(32));
              k.if($.ne($.and(k.l(HOLD), k.i(0xffff)), $.xor($.shrU(k.l(HOLD), k.i(16)), k.i(0xffff))), () => fail(E.STORED));
              k.put(LENGTH, $.and(k.l(HOLD), k.i(0xffff)));
              initbits();
              k.put(MODE, k.i(M.COPY_));
            },
            // COPY_
            () => {
              k.put(MODE, k.i(M.COPY));
            },
            // COPY
            () => {
              k.put(COPY, k.l(LENGTH));
              k.if($.ne(k.l(COPY), k.i(0)), () => {
                k.if($.gtU(k.l(COPY), $.sub(k.l(END), k.l(NXT))), () => k.put(COPY, $.sub(k.l(END), k.l(NXT))));
                k.brIf(leave, $.eq(k.l(COPY), k.i(0)));
                room(k.l(COPY));
                $.do($.g(this.OUT), k.l(PUT), $.g(this.IN), k.l(NXT), k.l(COPY));
                c.arrayCopy(this.B, this.B);
                k.put(NXT, $.add(k.l(NXT), k.l(COPY)));
                k.put(PUT, $.add(k.l(PUT), k.l(COPY)));
                k.put(LENGTH, $.sub(k.l(LENGTH), k.l(COPY)));
                brk();
              });
              k.put(MODE, k.i(M.TYPE));
              brk();
            },
            // TABLE
            () => {
              needbits(k.i(14));
              k.put(NLEN, $.add(bitsN(k.i(5)), k.i(257)));
              drop(k.i(5));
              k.put(NDIST, $.add(bitsN(k.i(5)), k.i(1)));
              drop(k.i(5));
              k.put(NCODE, $.add(bitsN(k.i(4)), k.i(4)));
              drop(k.i(4));
              k.if($.either($.gtU(k.l(NLEN), k.i(286)), $.gtU(k.l(NDIST), k.i(30))), () => fail(E.NSYMS));
              k.put(HAVE, k.i(0));
              k.put(MODE, k.i(M.LENLENS));
            },
            // LENLENS
            () => {
              k.while($.ltU(k.l(HAVE), k.l(NCODE)), () => {
                needbits(k.i(3));
                k.s16(I.LENS, k.m16(I.ORDER, k.l(HAVE)), bitsN(k.i(3)));
                k.put(HAVE, $.add(k.l(HAVE), k.i(1)));
                drop(k.i(3));
              });
              k.while($.ltU(k.l(HAVE), k.i(19)), () => {
                k.s16(I.LENS, k.m16(I.ORDER, k.l(HAVE)), k.i(0));
                k.put(HAVE, $.add(k.l(HAVE), k.i(1)));
              });
              k.put(NEXTT, k.i(I.CODES));
              k.put(LENCODE, k.l(NEXTT));
              k.if($.ne($.call(this.inflateTableFn(), k.i(CODES), k.i(I.LENS), k.i(19), k.l(NEXTT), k.i(7)), k.i(0)), () => fail(E.CLSET));
              k.put(NEXTT, k.G("t_next"));
              k.put(LENBITS, k.G("t_bits"));
              k.put(HAVE, k.i(0));
              k.put(MODE, k.i(M.CODELENS));
            },
            // CODELENS
            () => {
              k.while($.ltU(k.l(HAVE), $.add(k.l(NLEN), k.l(NDIST))), () => {
                lookup(k.l(LENCODE), () => bitsN(k.l(LENBITS)), () => hbits(HERE));
                k.if($.ltU(val(HERE), k.i(16)), () => {
                  drop(hbits(HERE));
                  k.s16(I.LENS, k.l(HAVE), val(HERE));
                  k.put(HAVE, $.add(k.l(HAVE), k.i(1)));
                }, () => {
                  k.if($.eq(val(HERE), k.i(16)), () => {
                    needbits($.add(hbits(HERE), k.i(2)));
                    drop(hbits(HERE));
                    k.if($.eq(k.l(HAVE), k.i(0)), () => fail(E.REPEAT));
                    k.put(LEN, k.m16(I.LENS, $.sub(k.l(HAVE), k.i(1))));
                    k.put(COPY, $.add(k.i(3), bitsN(k.i(2))));
                    drop(k.i(2));
                  }, () => {
                    k.if($.eq(val(HERE), k.i(17)), () => {
                      needbits($.add(hbits(HERE), k.i(3)));
                      drop(hbits(HERE));
                      k.put(LEN, k.i(0));
                      k.put(COPY, $.add(k.i(3), bitsN(k.i(3))));
                      drop(k.i(3));
                    }, () => {
                      needbits($.add(hbits(HERE), k.i(7)));
                      drop(hbits(HERE));
                      k.put(LEN, k.i(0));
                      k.put(COPY, $.add(k.i(11), bitsN(k.i(7))));
                      drop(k.i(7));
                    });
                  });
                  k.if($.gtU($.add(k.l(HAVE), k.l(COPY)), $.add(k.l(NLEN), k.l(NDIST))), () => fail(E.REPEAT));
                  k.while($.ne(k.l(COPY), k.i(0)), () => {
                    k.put(COPY, $.sub(k.l(COPY), k.i(1)));
                    k.s16(I.LENS, k.l(HAVE), k.l(LEN));
                    k.put(HAVE, $.add(k.l(HAVE), k.i(1)));
                  });
                });
              });
              k.if($.not(k.m16(I.LENS, k.i(256))), () => fail(E.NOEOB));
              k.put(NEXTT, k.i(I.CODES));
              k.put(LENCODE, k.l(NEXTT));
              k.if($.ne($.call(this.inflateTableFn(), k.i(LENS), k.i(I.LENS), k.l(NLEN), k.l(NEXTT), k.i(10)), k.i(0)), () => fail(E.LLSET));
              k.put(NEXTT, k.G("t_next"));
              k.put(LENBITS, k.G("t_bits"));
              k.put(DISTCODE, k.l(NEXTT));
              k.if($.ne($.call(this.inflateTableFn(), k.i(DISTS), $.add(k.i(I.LENS), $.shl(k.l(NLEN), k.i(1))), k.l(NDIST), k.l(NEXTT), k.i(9)), k.i(0)), () => fail(E.DSET));
              k.put(NEXTT, k.G("t_next"));
              k.put(DISTBITS, k.G("t_bits"));
              k.put(MODE, k.i(M.LEN_));
            },
            // LEN_
            () => {
              k.put(MODE, k.i(M.LEN));
            },
            // LEN (inflate_fast not ported: see the header)
            () => {
              lookup(k.l(LENCODE), () => bitsN(k.l(LENBITS)), () => hbits(HERE));
              k.if($.both($.ne(op(HERE), k.i(0)), $.not($.and(op(HERE), k.i(0xf0)))), () => {
                k.put(LASTC, k.l(HERE));
                lookup(k.l(LENCODE), () => $.add(val(LASTC), $.shrU(bitsN($.add(hbits(LASTC), op(LASTC))), hbits(LASTC))),
                  () => $.add(hbits(LASTC), hbits(HERE)));
                drop(hbits(LASTC));
              });
              drop(hbits(HERE));
              k.put(LENGTH, val(HERE));
              k.if($.not(op(HERE)), () => {
                k.put(MODE, k.i(M.LIT));
                brk();
              });
              k.if($.ne($.and(op(HERE), k.i(32)), k.i(0)), () => {
                k.put(MODE, k.i(M.TYPE));
                brk();
              });
              k.if($.ne($.and(op(HERE), k.i(64)), k.i(0)), () => fail(E.LLCODE));
              k.put(EXTRA, $.and(op(HERE), k.i(15)));
              k.put(MODE, k.i(M.LENEXT));
            },
            // LENEXT
            () => {
              k.if($.ne(k.l(EXTRA), k.i(0)), () => {
                needbits(k.l(EXTRA));
                k.put(LENGTH, $.add(k.l(LENGTH), bitsN(k.l(EXTRA))));
                drop(k.l(EXTRA));
              });
              k.put(MODE, k.i(M.DIST));
            },
            // DIST
            () => {
              lookup(k.l(DISTCODE), () => bitsN(k.l(DISTBITS)), () => hbits(HERE));
              k.if($.not($.and(op(HERE), k.i(0xf0))), () => {
                k.put(LASTC, k.l(HERE));
                lookup(k.l(DISTCODE), () => $.add(val(LASTC), $.shrU(bitsN($.add(hbits(LASTC), op(LASTC))), hbits(LASTC))),
                  () => $.add(hbits(LASTC), hbits(HERE)));
                drop(hbits(LASTC));
              });
              drop(hbits(HERE));
              k.if($.ne($.and(op(HERE), k.i(64)), k.i(0)), () => fail(E.DCODE));
              k.put(OFFSET, val(HERE));
              k.put(EXTRA, $.and(op(HERE), k.i(15)));
              k.put(MODE, k.i(M.DISTEXT));
            },
            // DISTEXT
            () => {
              k.if($.ne(k.l(EXTRA), k.i(0)), () => {
                needbits(k.l(EXTRA));
                k.put(OFFSET, $.add(k.l(OFFSET), bitsN(k.l(EXTRA))));
                drop(k.l(EXTRA));
              });
              k.put(MODE, k.i(M.MATCH));
            },
            // MATCH: the output so far is the window
            () => {
              k.if($.gtU(k.l(OFFSET), k.l(PUT)), () => fail(E.FAR));
              room(k.l(LENGTH));
              k.put(FROM, $.sub(k.l(PUT), k.l(OFFSET)));
              k.for(J, k.i(0), k.l(LENGTH), () => {
                $.aset(this.B, $.g(this.OUT), $.add(k.l(PUT), k.l(J)), $.agetU(this.B, $.g(this.OUT), $.add(k.l(FROM), k.l(J))));
              });
              k.put(PUT, $.add(k.l(PUT), k.l(LENGTH)));
              k.put(MODE, k.i(M.LEN));
              brk();
            },
            // LIT
            () => {
              room(k.i(1));
              $.aset(this.B, $.g(this.OUT), k.l(PUT), k.l(LENGTH));
              k.put(PUT, $.add(k.l(PUT), k.i(1)));
              k.put(MODE, k.i(M.LEN));
              brk();
            },
            // CHECK
            () => {
              needbits(k.i(32));
              // ZSWAP32(hold) against the adler32 of everything written
              k.put(LEN, $.or($.or($.shl(k.l(HOLD), k.i(24)), $.shl($.and(k.l(HOLD), k.i(0xff00)), k.i(8))),
                $.or($.and($.shrU(k.l(HOLD), k.i(8)), k.i(0xff00)), $.shrU(k.l(HOLD), k.i(24)))));
              k.if($.ne(k.l(LEN), $.call(this.adler32Fn(), k.i(1), $.g(this.OUT), k.i(0), k.l(PUT))), () => fail(E.CHECK));
              initbits();
              k.put(MODE, k.i(M.DONE));
            },
            // DONE
            () => {
              k.put(R, $.anew(this.B, k.l(PUT)));
              $.do(k.l(R), k.i(0), $.g(this.OUT), k.i(0), k.l(PUT));
              c.arrayCopy(this.B, this.B);
              $.gput(this.IN, $.nul(this.B));
              $.gput(this.OUT, $.nul(this.B));
              k.ret($.new_(this.BT, $.raw((cc) => {
                cc.localGet(R);
                cc.refAsNonNull();
              }), k.i(0), k.l(PUT)));
            },
          ]);
          // a case that falls out of the switch loops (none do: each
          // ends in a branch, a return, or the next case)
          brk();
        });
      });
      // inf_leave with input exhausted: Z_BUF_ERROR under Z_FINISH
      fail(E.EOF);
      k.$.trap();
    });
  }
}
