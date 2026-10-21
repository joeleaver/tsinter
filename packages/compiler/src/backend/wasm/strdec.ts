/* INC-28 U3 — node:string_decoder's StringDecoder on the WasmGC tier: the
 * three PURE functions the front end's interned %strdec helpers thread the
 * decoder's state through (ir/validate.ts):
 *
 *   strdec.write(enc, pending, chunk) -> string  the decoded complete prefix
 *   strdec.next(enc, pending, chunk)  -> f64     the state after that write
 *   strdec.end(enc, pending)          -> string  the flush
 *
 * `enc` is the CANONICAL encoding name the front end folded at
 * construction (utf8, utf16le, base64, base64url, latin1, ascii, hex).
 * `pending` is the IR's packed state: the count of buffered bytes in the
 * low byte, then up to three raw bytes (count | b0 << 8 | b1 << 16 |
 * b2 << 24) — exact in an f64. Three is enough for every encoding Node
 * buffers: utf8 holds at most 3 bytes of a 4-byte sequence, utf16le at
 * most a lead surrogate and one byte of its trail, base64 at most 2 bytes
 * of a 3-byte group (Node's own kIncompleteCharactersEnd is 4, and a
 * 4th buffered byte always completes the character).
 *
 * THE ALGORITHM is Node v24.18.1's src/string_decoder.cc (DecodeData,
 * FlushData), the judge; packages/runtime/src/scr_bytes.c's scr_strdec_*
 * is a second reading of it. Node decodes a write as (the completed
 * buffered character) ++ (the chunk minus a new trailing partial); this
 * file decodes the COMBINED buffer pending ++ chunk minus its trailing
 * partial in one call, which is the same string:
 *   - utf8: a completed buffered sequence ends exactly where the decoder
 *     of the joint buffer is back at a fresh state (its lead's length, or
 *     an interrupting non-continuation byte, which Node's own fill loop
 *     stops at too), and the trailing-partial test (Node's backwards scan
 *     over at most four bytes, its `(b & 0xC0) == 0x80` continuation test
 *     and its lead-length table, which treats F5..F7 as 4-byte leads) is
 *     the same over the body as over the joint tail;
 *   - utf16le: a buffered odd byte completes its code unit, a buffered lead
 *     surrogate its 4 bytes, whatever they are (Node emits that unit or
 *     pair as a string and concatenates, so a lead completed by the odd
 *     byte is emitted even though it is a lead — and the trail that comes
 *     next joins it, exactly as a joint decode does); the rest holds back
 *     an odd last byte (with NO surrogate test, Node's rule) or else a
 *     trailing lead surrogate's 2 bytes;
 *   - base64/base64url: whole 3-byte groups encode now, the remainder
 *     buffers (base64 of a concatenation splits at group boundaries);
 *   - latin1/ascii/hex: stateless, write IS Buffer.toString.
 * end() flushes: utf8 decodes the buffered bytes (their replacement
 * chars), base64 encodes them (padded; unpadded for base64url), utf16le
 * drops a trailing odd byte and decodes the rest (a held lead surrogate
 * flushes as that lone surrogate, as in Node), the stateless three flush
 * "". Every decode goes through the tier's own Buffer.toString decoders
 * (typedarrays.ts), so a StringDecoder and a Buffer agree on every
 * replacement. The rows that pin all of this against Node live in
 * packages/compiler/test/wasm-strdec-u3.test.ts. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export interface StrdecDeps {
  strRef: () => ValType;
  /** `%w.strEq(a, b) -> i32`. */
  strEq: () => number;
  pushStrLit: (c: Code, value: string) => void;
  /** The $bytes struct and its i8 storage array (typedarrays.ts). */
  bytesType: () => number;
  bufType: () => number;
  /** `%w.bytes.toStr:<enc>(bytes) -> string`. */
  toStr: (enc: string) => number;
}

/** The canonical names, in the order of their codes (1-based). */
const ENCODINGS = ["utf8", "utf16le", "base64", "base64url", "latin1", "ascii", "hex"] as const;
const E_UTF8 = 1;
const E_UTF16 = 2;
const E_B64 = 3;
const E_B64URL = 4;

/* $bytes field indices (typedarrays.ts's layout). */
const STORAGE = 0;
const OFF = 1;
const BLEN = 2;

export class StrdecBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: StrdecDeps,
  ) {}

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.strdec.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  private bytesRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.bytesType() };
  }

  private bufRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.bufType() };
  }

  /** `%w.strdec.code(enc) -> i32`: the encoding's code (1..7); any other
   * name is unreachable (the front end folds every alias). */
  private codeHelper(): number {
    return this.cached("code", [this.deps.strRef()], [I32], (idx) => {
      const c = new Code();
      ENCODINGS.forEach((name, i) => {
        c.localGet(0);
        this.deps.pushStrLit(c, name);
        c.call(this.deps.strEq());
        c.ifVoid();
        c.i32Const(i + 1);
        c.return_();
        c.end();
      });
      c.unreachable();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.strdec.decodeView(code, buf, len) -> string`: buf[0..len). */
  private decodeViewHelper(): number {
    return this.cached("decodeView", [I32, this.bufRef(), I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.i32Const(0);
      c.localGet(2);
      c.call(this.viewDecodeHelper());
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.strdec.unpack(pending, out) -> count`: the packed bytes written to
   * out[0..count) (out holds at least 3). */
  private unpackHelper(): number {
    return this.cached("unpack", [F64, this.bufRef()], [I32], (idx) => {
      const c = new Code();
      const P = 2;
      const N = 3;
      c.localGet(0);
      c.i32TruncF64U();
      c.localSet(P);
      c.localGet(P);
      c.i32Const(0xff);
      c.i32And();
      c.localSet(N);
      // A count above 3 is not a state this file ever packs.
      c.localGet(N);
      c.i32Const(3);
      c.i32GtU();
      c.ifVoid();
      c.unreachable();
      c.end();
      for (let k = 0; k < 3; k++) {
        c.localGet(1);
        c.i32Const(k);
        c.localGet(P);
        c.i32Const(8 * (k + 1));
        c.i32ShrU();
        c.arraySet(this.deps.bufType());
      }
      c.localGet(N);
      this.mb.setBody(idx, [I32, I32], c.bytes());
    });
  }

  /** `%w.strdec.pack(buf, from, n) -> f64`: buf[from..from+n) packed
   * (n <= 3). */
  private packHelper(): number {
    return this.cached("pack", [this.bufRef(), I32, I32], [F64], (idx) => {
      const c = new Code();
      const BUF = 0;
      const FROM = 1;
      const N = 2;
      const P = 3;
      c.localGet(N);
      c.i32Const(3);
      c.i32GtU();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.localGet(N);
      c.localSet(P);
      for (let k = 0; k < 3; k++) {
        c.localGet(N);
        c.i32Const(k);
        c.i32GtU();
        c.ifVoid();
        c.localGet(P);
        c.localGet(BUF);
        c.localGet(FROM);
        c.i32Const(k);
        c.i32Add();
        c.arrayGetU(this.deps.bufType());
        c.i32Const(8 * (k + 1));
        c.i32Shl();
        c.i32Or();
        c.localSet(P);
        c.end();
      }
      c.localGet(P);
      c.f64ConvertI32U();
      this.mb.setBody(idx, [I32], c.bytes());
    });
  }

  /** `%w.strdec.utf8Tail(buf, n) -> i32`: the length (0-3) of a trailing
   * truncated sequence prefix of buf[0..n) — Node's backwards scan: walk
   * back over continuation bytes (at most three); the first other byte is
   * a lead of length 2 (110xxxxx), 3 (1110xxxx) or 4 (11110xxx), and the
   * tail buffers exactly when fewer bytes than that follow it, counting
   * itself; ASCII, any other lead, four continuations or the buffer's
   * start buffer nothing. */
  private utf8TailHelper(): number {
    return this.cached("utf8Tail", [this.bufRef(), I32], [I32], (idx) => {
      const c = new Code();
      const BUF = 0;
      const N = 1;
      const BACK = 2;
      const B = 3;
      const NEED = 4;
      c.i32Const(1);
      c.localSet(BACK);
      c.block();
      c.loop();
      // back > min(n, 3): nothing buffers.
      c.localGet(BACK);
      c.localGet(N);
      c.i32GtS();
      c.localGet(BACK);
      c.i32Const(3);
      c.i32GtS();
      c.i32Or();
      c.brIf(1);
      c.localGet(BUF);
      c.localGet(N);
      c.localGet(BACK);
      c.i32Sub();
      c.arrayGetU(this.deps.bufType());
      c.localSet(B);
      c.localGet(B);
      c.i32Const(0xc0);
      c.i32And();
      c.i32Const(0x80);
      c.i32Eq();
      c.ifVoid();
      c.localGet(BACK);
      c.i32Const(1);
      c.i32Add();
      c.localSet(BACK);
      c.br(1);
      c.end();
      c.i32Const(0);
      c.localSet(NEED);
      c.localGet(B);
      c.i32Const(0xe0);
      c.i32And();
      c.i32Const(0xc0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(2);
      c.localSet(NEED);
      c.end();
      c.localGet(B);
      c.i32Const(0xf0);
      c.i32And();
      c.i32Const(0xe0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(3);
      c.localSet(NEED);
      c.end();
      c.localGet(B);
      c.i32Const(0xf8);
      c.i32And();
      c.i32Const(0xf0);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(4);
      c.localSet(NEED);
      c.end();
      c.localGet(BACK);
      c.localGet(NEED);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(BACK);
      c.else_();
      c.i32Const(0);
      c.end();
      c.return_();
      c.end();
      c.end();
      c.i32Const(0);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
    });
  }

  /** `%w.strdec.step(enc, pending, chunk) -> (string, f64)`: one write —
   * the decoded string and the new packed state. */
  private stepHelper(): number {
    const str = this.deps.strRef();
    return this.cached("step", [str, F64, this.bytesRef()], [str, F64], (idx) => {
      const c = new Code();
      const ENC = 0;
      const PEND = 1;
      const CH = 2;
      const CODE = 3;
      const K = 4;
      const LEN = 5;
      const N = 6;
      const TAIL = 7;
      const START = 8;
      const KEEP = 9;
      const REST = 10;
      const UNIT = 11;
      const BUF = 12; // the combined buffer
      const bufT = this.deps.bufType();
      const bytesT = this.deps.bytesType();
      c.localGet(ENC);
      c.call(this.codeHelper());
      c.localSet(CODE);
      // The stateless three: write IS toString, and the state stays 0.
      c.localGet(CODE);
      c.i32Const(E_B64URL);
      c.i32GtU();
      c.ifVoid();
      c.localGet(CODE);
      c.localGet(CH);
      c.structGet(bytesT, STORAGE);
      c.localGet(CH);
      c.structGet(bytesT, OFF);
      c.localGet(CH);
      c.structGet(bytesT, BLEN);
      c.call(this.viewDecodeHelper());
      c.f64Const(0);
      c.return_();
      c.end();
      // The combined buffer: the pending bytes, then the chunk's.
      c.localGet(CH);
      c.structGet(bytesT, BLEN);
      c.localSet(LEN);
      c.localGet(LEN);
      c.i32Const(3);
      c.i32Add();
      c.arrayNewDefault(bufT);
      c.localSet(BUF);
      c.localGet(PEND);
      c.localGet(BUF);
      c.call(this.unpackHelper());
      c.localSet(K);
      c.localGet(BUF);
      c.localGet(K);
      c.localGet(CH);
      c.structGet(bytesT, STORAGE);
      c.localGet(CH);
      c.structGet(bytesT, OFF);
      c.localGet(LEN);
      c.arrayCopy(bufT, bufT);
      c.localGet(K);
      c.localGet(LEN);
      c.i32Add();
      c.localSet(N);
      // utf8: the joint buffer minus its trailing partial sequence.
      c.localGet(CODE);
      c.i32Const(E_UTF8);
      c.i32Eq();
      c.ifVoid();
      c.localGet(BUF);
      c.localGet(N);
      c.call(this.utf8TailHelper());
      c.localSet(TAIL);
      this.emitResult(c, CODE, BUF, N, TAIL);
      c.return_();
      c.end();
      // base64 / base64url: whole groups now, the remainder buffers.
      c.localGet(CODE);
      c.i32Const(E_B64);
      c.i32Eq();
      c.localGet(CODE);
      c.i32Const(E_B64URL);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(N);
      c.i32Const(3);
      c.i32RemS();
      c.localSet(TAIL);
      this.emitResult(c, CODE, BUF, N, TAIL);
      c.return_();
      c.end();
      // utf16le. A buffered partial fills first: an odd byte completes its
      // unit (2 bytes in all), a held lead surrogate its pair (4); too few
      // new bytes and everything stays buffered.
      c.localGet(CODE);
      c.i32Const(E_UTF16);
      c.i32Ne();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.i32Const(0);
      c.localSet(START);
      c.localGet(K);
      c.ifVoid();
      c.localGet(K);
      c.i32Const(1);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(2);
      c.else_();
      c.i32Const(4);
      c.end();
      c.localSet(START);
      c.localGet(N);
      c.localGet(START);
      c.i32LtS();
      c.ifVoid();
      // Still incomplete: nothing decodes, all N (<= 3) bytes stay.
      this.deps.pushStrLit(c, "");
      c.localGet(BUF);
      c.i32Const(0);
      c.localGet(N);
      c.call(this.packHelper());
      c.return_();
      c.end();
      c.end();
      // The rest after the filled unit: hold an odd last byte; else a
      // trailing lead surrogate (its high byte D8..DB).
      c.localGet(N);
      c.localGet(START);
      c.i32Sub();
      c.localSet(REST);
      c.localGet(REST);
      c.localSet(KEEP);
      c.localGet(REST);
      c.i32Const(1);
      c.i32And();
      c.ifVoid();
      c.localGet(REST);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(KEEP);
      c.else_();
      c.localGet(REST);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid();
      c.localGet(BUF);
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(bufT);
      c.localSet(UNIT);
      c.localGet(UNIT);
      c.i32Const(0xfc);
      c.i32And();
      c.i32Const(0xd8);
      c.i32Eq();
      c.ifVoid();
      c.localGet(REST);
      c.i32Const(2);
      c.i32Sub();
      c.localSet(KEEP);
      c.end();
      c.end();
      c.end();
      c.localGet(N);
      c.localGet(START);
      c.localGet(KEEP);
      c.i32Add();
      c.i32Sub();
      c.localSet(TAIL);
      this.emitResult(c, CODE, BUF, N, TAIL);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32, I32, I32, this.bufRef()], c.bytes());
    });
  }

  /** Push (decode(BUF[0..N-TAIL)), pack(BUF[N-TAIL..N))). */
  private emitResult(c: Code, CODE: number, BUF: number, N: number, TAIL: number): void {
    c.localGet(CODE);
    c.localGet(BUF);
    c.localGet(N);
    c.localGet(TAIL);
    c.i32Sub();
    c.call(this.decodeViewHelper());
    c.localGet(BUF);
    c.localGet(N);
    c.localGet(TAIL);
    c.i32Sub();
    c.localGet(TAIL);
    c.call(this.packHelper());
  }

  /** `%w.strdec.viewDecode(code, storage, off, len) -> string`: decode a
   * chunk where it lies (no copy). */
  private viewDecodeHelper(): number {
    return this.cached("viewDecode", [I32, this.bufRef(), I32, I32], [this.deps.strRef()], (idx) => {
      const c = new Code();
      ENCODINGS.forEach((name, i) => {
        c.localGet(0);
        c.i32Const(i + 1);
        c.i32Eq();
        c.ifVoid();
        c.localGet(1);
        c.refAsNonNull();
        c.localGet(2);
        c.localGet(3);
        c.structNew(this.deps.bytesType());
        c.call(this.deps.toStr(name));
        c.return_();
        c.end();
      });
      c.unreachable();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.strdec.write(enc, pending, chunk) -> string`. */
  writeHelper(): number {
    const str = this.deps.strRef();
    return this.cached("write", [str, F64, this.bytesRef()], [str], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.call(this.stepHelper());
      c.drop();
      this.mb.setBody(idx, [], c.bytes());
    });
  }

  /** `%w.strdec.next(enc, pending, chunk) -> f64`. */
  nextHelper(): number {
    const str = this.deps.strRef();
    return this.cached("next", [str, F64, this.bytesRef()], [F64], (idx) => {
      const c = new Code();
      const HOLD = 3;
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.call(this.stepHelper());
      c.localSet(HOLD);
      c.drop();
      c.localGet(HOLD);
      this.mb.setBody(idx, [F64], c.bytes());
    });
  }

  /** `%w.strdec.end(enc, pending) -> string`: Node's FlushData. */
  endHelper(): number {
    const str = this.deps.strRef();
    return this.cached("end", [str, F64], [str], (idx) => {
      const c = new Code();
      const ENC = 0;
      const PEND = 1;
      const CODE = 2;
      const K = 3;
      const BUF = 4;
      c.localGet(ENC);
      c.call(this.codeHelper());
      c.localSet(CODE);
      // The stateless three flush nothing.
      c.localGet(CODE);
      c.i32Const(E_B64URL);
      c.i32GtU();
      c.ifVoid();
      this.deps.pushStrLit(c, "");
      c.return_();
      c.end();
      c.i32Const(3);
      c.arrayNewDefault(this.deps.bufType());
      c.localSet(BUF);
      c.localGet(PEND);
      c.localGet(BUF);
      c.call(this.unpackHelper());
      c.localSet(K);
      // utf16le ignores a single trailing byte ("like the JS decoder does").
      c.localGet(CODE);
      c.i32Const(E_UTF16);
      c.i32Eq();
      c.ifVoid();
      c.localGet(K);
      c.i32Const(-2);
      c.i32And();
      c.localSet(K);
      c.end();
      c.localGet(CODE);
      c.localGet(BUF);
      c.localGet(K);
      c.call(this.decodeViewHelper());
      this.mb.setBody(idx, [I32, I32, this.bufRef()], c.bytes());
    });
  }
}
