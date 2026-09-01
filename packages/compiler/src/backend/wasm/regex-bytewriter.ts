/* INC-24 P1, CP3: the assembler's byte buffer — a TypeScript equivalent
 * of libregexp.c's `DynBuf byte_code` plus the handful of raw operations
 * the reference calls on it directly (dbuf_putc, dbuf_put_u16,
 * dbuf_put_u32, dbuf_insert, put_u32/get_u32 for backpatching). Growable
 * arrays already handle capacity management, so — like regex-charclass.ts's
 * CharRange choosing a plain array over the reference's own
 * size/realloc_func struct — this drops DynBuf's capacity bookkeeping
 * and keeps only the byte-level operations that have observable effect
 * on the emitted bytes. All values are little-endian, matching
 * libregexp.c's put_u16/put_u32 (quickjs's cutils.h helpers) on every
 * platform this reference targets. */
export class RegexByteWriter {
  private bytes: number[] = [];

  get size(): number {
    return this.bytes.length;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }

  /** dbuf_putc — a single byte. */
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  /** dbuf_put_u16 — little-endian. */
  u16(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
  }

  /** dbuf_put_u32 — little-endian. */
  u32(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  /** put_u32 — OVERWRITE 4 already-written bytes at `pos` (backpatching
   * a jump offset or the header's bytecode-length field), little-endian,
   * matching the reference's own `put_u32(buf+pos, val)` call sites. */
  patchU32(pos: number, v: number): void {
    this.bytes[pos] = v & 0xff;
    this.bytes[pos + 1] = (v >>> 8) & 0xff;
    this.bytes[pos + 2] = (v >>> 16) & 0xff;
    this.bytes[pos + 3] = (v >>> 24) & 0xff;
  }

  /** OVERWRITE a single already-written byte at `pos` — the reference's
   * `s->byte_code.buf[start] = REOP_split_next_first` idiom
   * (re_parse_disjunction, libregexp.c:2435): after insertZeros makes
   * room, the opcode byte itself is written directly into the reserved
   * slot, not appended. */
  patchU8(pos: number, v: number): void {
    this.bytes[pos] = v & 0xff;
  }

  /** get_u32 — read back 4 already-written bytes, little-endian (needed
   * by re_parse_disjunction's alternation-chain backpatch walk, which
   * reads a previously-stored "next" link before overwriting it). */
  readU32(pos: number): number {
    return (this.bytes[pos]! | (this.bytes[pos + 1]! << 8) | (this.bytes[pos + 2]! << 16) | (this.bytes[pos + 3]! << 24)) >>> 0;
  }

  /** A single already-written byte — needed by
   * re_need_check_adv_and_capture_init's own bytecode scan (it walks the
   * just-emitted atom's bytes to decide the quantifier-compilation
   * strategy), and by REOP_SIZE-driven bytecode walks generally. */
  byteAt(pos: number): number {
    return this.bytes[pos]!;
  }

  /** get_u16 at an already-written position — the same scan needs the
   * range/range_i's own variable-length count field. */
  readU16(pos: number): number {
    return (this.bytes[pos]! | (this.bytes[pos + 1]! << 8)) >>> 0;
  }

  /** dbuf_insert — splice `len` zero bytes in at `pos`, shifting
   * everything from `pos` onward forward by `len` (the reference's own
   * "wrap an already-emitted atom in quantifier opcodes" trick: emit the
   * atom first, THEN retroactively insert the wrapping opcode bytes
   * before it). Returns nothing; caller overwrites the inserted region
   * via u8/u16/u32 calls at `pos`. */
  insertZeros(pos: number, len: number): void {
    const zeros = new Array<number>(len).fill(0);
    this.bytes.splice(pos, 0, ...zeros);
  }

  /** Truncates the buffer back to `size` bytes (libregexp.c:2307's
   * `s->byte_code.size = last_atom_start` — discarding an atom entirely
   * when a quantifier's max is 0). */
  truncate(size: number): void {
    this.bytes.length = size;
  }

  /** re_parse_alternative's own term-reversal idiom (libregexp.c:2399-
   * 2411, its `memmove`+`memcpy` pair): move the byte range [moveStart,
   * moveEnd) to begin at `blockStart` (blockStart <= moveStart),
   * preserving the moved bytes' OWN internal order, and shifting
   * whatever was between blockStart and moveStart to the right by
   * (moveEnd - moveStart). Called once per term, in a backward-direction
   * alternative, to incrementally prepend each newly-emitted term before
   * all previously-emitted (and already-reversed) terms of the same
   * alternative — the net effect, after all terms are processed, is the
   * terms in fully reversed order. Implemented via extract-then-reinsert
   * (two splices) rather than the reference's raw memmove+memcpy: the
   * 1:1 mandate binds the OBSERVABLE byte layout this produces, not the
   * C-specific two-pointer trick used to reach it. */
  moveToFront(blockStart: number, moveStart: number, moveEnd: number): void {
    const moved = this.bytes.splice(moveStart, moveEnd - moveStart);
    this.bytes.splice(blockStart, 0, ...moved);
  }
}
