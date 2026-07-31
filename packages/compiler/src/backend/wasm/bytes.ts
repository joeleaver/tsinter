/* The wasm binary's primitive encodings, and nothing else: LEB128 integers,
 * IEEE754 doubles, length-prefixed UTF-8 names, and the size-prefixed
 * framing that sections, code entries, and sub-expressions all share. This
 * is the layer that keeps the emitter free of byte arithmetic — everything
 * above it appends structure, never offsets. No wasm OPCODES live here:
 * which byte means i32.add is the emitter's knowledge, how to write an
 * integer is this file's.
 *
 * Integers stay JS numbers, not BigInts: every quantity the backend emits
 * today (type/function/local/global indices, vector lengths, i32.const
 * immediates, data offsets) fits comfortably in 32 bits, and the writers
 * ASSERT that instead of silently wrapping — an out-of-range value is an
 * emitter bug, and a loud throw here beats a module that fails validation
 * three layers away. i64.const grows a BigInt writer when something needs
 * it, not before. */

const utf8 = new TextEncoder();

export class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  get length(): number {
    return this.len;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(b: number): void {
    this.grow(1);
    this.buf[this.len++] = b;
  }

  raw(bytes: Uint8Array): void {
    this.grow(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Unsigned LEB128. Callers pass counts and indices; a negative or
   * non-integral value is an emitter bug, never data. */
  uleb(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
      throw new Error(`uleb128 out of u32 range: ${n}`);
    }
    do {
      let byte = n & 0x7f;
      n = Math.floor(n / 128);
      if (n !== 0) byte |= 0x80;
      this.u8(byte);
    } while (n !== 0);
  }

  /** Signed LEB128 (i32.const immediates, block types, heap type indices —
   * the s33 positions accept any non-negative index below 2^31, which this
   * range covers). */
  sleb(n: number): void {
    if (!Number.isInteger(n) || n < -0x8000_0000 || n > 0x7fff_ffff) {
      throw new Error(`sleb128 out of i32 range: ${n}`);
    }
    for (;;) {
      const byte = n & 0x7f;
      n >>= 7;
      const signBit = (byte & 0x40) !== 0;
      if ((n === 0 && !signBit) || (n === -1 && signBit)) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }

  /** Signed LEB128 over the full i64 range — the i64.const immediate.
   * BigInt because the interesting i64 constants (mantissa masks, 1n<<52n)
   * exceed the double-exact integer range. */
  sleb64(n: bigint): void {
    if (n < -0x8000_0000_0000_0000n || n > 0x7fff_ffff_ffff_ffffn) {
      throw new Error(`sleb128 out of i64 range: ${n}`);
    }
    for (;;) {
      const byte = Number(n & 0x7fn);
      n >>= 7n;
      const signBit = (byte & 0x40) !== 0;
      if ((n === 0n && !signBit) || (n === -1n && signBit)) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }

  /** IEEE754 double, little-endian — the f64.const immediate. */
  f64(v: number): void {
    this.grow(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
  }

  /** A wasm name: uleb byte length, then UTF-8 bytes. */
  name(s: string): void {
    const bytes = utf8.encode(s);
    this.uleb(bytes.length);
    this.raw(bytes);
  }

  /** Size-prefixed framing — the shape sections, code entries, and every
   * other byte-counted region share: the body writes into its own writer,
   * and the byte length lands in front of it. The prefix is a plain uleb
   * (no fixed-width padding): the body is fully materialized before the
   * length is written, so nothing needs patching. */
  framed(body: (w: ByteWriter) => void): void {
    const inner = new ByteWriter();
    body(inner);
    this.uleb(inner.len);
    this.raw(inner.bytes());
  }

  /** A section: id byte, then the size-prefixed payload. */
  section(id: number, body: (w: ByteWriter) => void): void {
    this.u8(id);
    this.framed(body);
  }
}
