/* The node:crypto core on the WasmGC tier: the keys the frontend lowers
 * (ir/nodes.ts) computed in the module, from Node v24.18.1's behaviour
 * and the OpenSSL 3.5 code paths Node drives:
 *
 *   - crypto.randomUUID (lib/internal/crypto/random.js: 16 random bytes,
 *     version 4, variant 10xx, lowercase 8-4-4-4-12), randomBytes(n) as a
 *     Buffer and the composed randomBytes(n).toString("hex" | "base64").
 *     The bytes come from the host's `random` import (abi.ts), an entropy
 *     read like getrandom(2), at most RANDOM_CHUNK bytes per call. The size
 *     check (Node's ERR_OUT_OF_RANGE) is the emitter's, at the call site.
 *   - The composed createHash(alg).update(data).digest(enc): sha256 (FIPS
 *     180-4) and sha1 (tls-x509.ts's), hex or base64; strings hash their
 *     UTF-8 bytes.
 *   - new X509Certificate(data).fingerprint / validFrom / validTo:
 *     ncrypto's X509Pointer::Parse — PEM_read_bio_X509_AUX over the bytes
 *     (the first certificate block: tls-x509.ts's reader in its first-only
 *     mode), else d2i_X509_bio over the raw bytes; the fingerprint is the
 *     SHA-1 of the DER as uppercase colon hex (X509_digest), the validity
 *     times print in ASN1_TIME_print's RFC 822 shape. The errors the
 *     parse can raise are the emitter's (X509_* codes below), so a caller
 *     sets the exception cell where it already walks a function.
 *
 * SEMANTICS.md S093 registers where this tier and Node part. */
import { A, Fn, type X } from "./asm.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";
import { PEM_NONCANON, type X509Builder } from "./tls-x509.js";

export interface CryptoDeps {
  strRef: () => ValType;
  strType: () => number;
  bufType: () => number;
  bytesType: () => number;
  x509: () => X509Builder;
  /** `(bytes<u8>) -> string`: buf.toString(enc). */
  toStr: (enc: "hex" | "base64") => number;
  /** tsinter.random's function index (abi.ts). */
  randomFunc: () => number;
  /** Grow linear memory so `need` bytes fit past the staging cursor. */
  ensureCapacity: (c: import("./code.js").Code, need: () => void) => void;
  stageCursor: () => number;
}

/** The most bytes one `random` call asks for (getRandomValues' own cap is
 * 65536). */
export const RANDOM_CHUNK = 4096;

/* The X509 parse's outcome (the error global): PEM_* from tls-x509.ts
 * (1 bad base64, 2 ASN.1, 3 bad end line, 4 unsupported PEM form, 5 a DER
 * OpenSSL re-encodes, 6 bytes after the certificate in a PEM block), then
 * these. */
/** Neither a PEM certificate nor a DER one: Node's "no start line". */
export const X509_NO_START = 7;
/** A validity time outside the canonical RFC 5280 forms (a named fence). */
export const X509_BAD_TIME = 8;

/** sha256's round constants (FIPS 180-4 §4.2.2). */
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const H256 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

export class CryptoBuilder {
  private readonly fns = new Map<string, number>();
  private errField: number | null = null;
  private kField: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: CryptoDeps,
  ) {}

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.crypto.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }
  private get S(): number {
    return this.deps.strType();
  }
  private get B(): number {
    return this.deps.bufType();
  }
  private get BT(): number {
    return this.deps.bytesType();
  }
  private get sRef(): ValType {
    return this.deps.strRef();
  }
  private get bRef(): ValType {
    return this.ref(this.B);
  }
  private get btRef(): ValType {
    return this.ref(this.BT);
  }
  private get x(): X509Builder {
    return this.deps.x509();
  }
  private get I32A(): number {
    return this.x.I32A;
  }

  /** The X509 parse's outcome global (X509_* / PEM_*), read by the
   * emitter when a parse answers null. */
  errGlobal(): number {
    this.errField ??= this.mb.addGlobal(I32, true, (w) => {
      w.u8(0x41);
      w.sleb(0);
    });
    return this.errField;
  }

  /** A fresh bytes<u8> over a whole storage array. */
  private wrap($: A, buf: X, len: X): X {
    return $.new_(this.BT, $.raw((c) => {
      buf();
      c.refAsNonNull();
    }), $.i(0), len);
  }

  /* ── randomness ───────────────────────────────────────────────────── */

  /** `(n) -> bytes<u8>` — n bytes from the host's entropy (n >= 0, the
   * emitter's checked size). */
  randomBytesFn(): number {
    return this.fn("randomBytes", [I32], [this.btRef], (f, $) => {
      const N = 0;
      const R = f.local(this.bRef);
      const P = f.local(I32);
      const K = f.local(I32);
      const I = f.local(I32);
      const CUR = this.deps.stageCursor();
      $.put(R, $.anew(this.B, $.l(N)));
      this.deps.ensureCapacity(f.c, () => f.c.i32Const(RANDOM_CHUNK));
      $.while($.lt($.l(P), $.l(N)), () => {
        $.put(K, $.sub($.l(N), $.l(P)));
        $.if($.gt($.l(K), $.i(RANDOM_CHUNK)), () => $.put(K, $.i(RANDOM_CHUNK)));
        $.run(this.deps.randomFunc(), $.g(CUR), $.l(K));
        $.for(I, $.i(0), $.l(K), () => {
          $.aset(this.B, $.l(R), $.add($.l(P), $.l(I)), $.raw((c) => {
            c.globalGet(CUR);
            c.localGet(I);
            c.i32Add();
            c.i32Load8U();
          }));
        });
        $.put(P, $.add($.l(P), $.l(K)));
      });
      $.do(this.wrap($, $.l(R), $.l(N)));
    });
  }

  /** `(n, enc) -> string` — randomBytes(n).toString(enc), enc "hex" or
   * "base64" (frontend-fenced). */
  randomStringFn(): number {
    return this.fn("randomString", [I32, this.sRef], [this.sRef], (f, $) => {
      const D = f.local(this.btRef);
      $.put(D, $.call(this.randomBytesFn(), $.l(0)));
      $.do(this.encode($, $.l(1), $.l(D)));
    });
  }

  /** bytes -> string by a runtime "hex" | "base64" (the only two the
   * frontend lets through; they differ in length). */
  private encode($: A, enc: X, d: X): X {
    return $.sel(this.sRef, $.eq($.alen(enc), $.i(3)), $.call(this.deps.toStr("hex"), d), $.call(this.deps.toStr("base64"), d));
  }

  /** `() -> string` — randomUUID(): RFC 9562 version 4. */
  randomUuidFn(): number {
    return this.fn("randomUUID", [], [this.sRef], (f, $) => {
      const D = f.local(this.btRef);
      const BUF = f.local(this.bRef);
      const R = f.local(this.sRef);
      const I = f.local(I32);
      const O = f.local(I32);
      const V = f.local(I32);
      $.put(D, $.call(this.randomBytesFn(), $.i(16)));
      $.put(BUF, $.get(this.BT, 0, $.l(D)));
      const byte = (i: X): X => $.agetU(this.B, $.l(BUF), i);
      $.aset(this.B, $.l(BUF), $.i(6), $.or($.and(byte($.i(6)), $.i(0x0f)), $.i(0x40)));
      $.aset(this.B, $.l(BUF), $.i(8), $.or($.and(byte($.i(8)), $.i(0x3f)), $.i(0x80)));
      $.put(R, $.anew(this.S, $.i(36)));
      const hexd = (v: X): X => $.sel(I32, $.lt(v, $.i(10)), $.add(v, $.i(48)), $.add(v, $.i(87)));
      $.for(I, $.i(0), $.i(16), () => {
        $.if($.either($.either($.eq($.l(I), $.i(4)), $.eq($.l(I), $.i(6))), $.either($.eq($.l(I), $.i(8)), $.eq($.l(I), $.i(10)))), () => {
          $.aset(this.S, $.l(R), $.l(O), $.i(45));
          $.put(O, $.add($.l(O), $.i(1)));
        });
        $.put(V, byte($.l(I)));
        $.aset(this.S, $.l(R), $.l(O), hexd($.shrU($.l(V), $.i(4))));
        $.aset(this.S, $.l(R), $.add($.l(O), $.i(1)), hexd($.and($.l(V), $.i(15))));
        $.put(O, $.add($.l(O), $.i(2)));
      });
      $.do($.l(R));
    });
  }

  /* ── hashes ───────────────────────────────────────────────────────── */

  /** The round constants as an i32 array (made once). */
  private kFn(): number {
    return this.fn("k256", [], [this.ref(this.I32A)], (f, $) => {
      this.kField ??= this.mb.addGlobal(this.ref(this.I32A), true, (w) => {
        w.u8(0xd0);
        w.sleb(this.I32A);
      });
      const G = this.kField;
      $.if($.isNull($.g(G)), () => {
        for (const k of K256) f.c.i32Const(k | 0);
        f.c.arrayNewFixed(this.I32A, K256.length);
        f.c.globalSet(G);
      });
      $.do($.g(G));
    });
  }

  /** `(buf, off, len) -> i32[8]` — SHA-256 (FIPS 180-4), the digest's
   * eight big-endian words. */
  sha256Fn(): number {
    return this.fn("sha256", [this.bRef, I32, I32], [this.ref(this.I32A)], (f, $) => {
      const [BUF, OFF, LEN] = [0, 1, 2];
      const H = f.local(this.ref(this.I32A));
      const W = f.local(this.ref(this.I32A));
      const KA = f.local(this.ref(this.I32A));
      const BLK = f.local(I32);
      const NBLK = f.local(I32);
      const T = f.local(I32);
      const J = f.local(I32);
      const P = f.local(I32);
      const BV = f.local(I32);
      const v = [0, 1, 2, 3, 4, 5, 6, 7].map(() => f.local(I32));
      const T1 = f.local(I32);
      const T2 = f.local(I32);
      const TMP = f.local(I32);
      const rotr = (x: X, n: number): X => $.or($.shrU(x, $.i(n)), $.shl(x, $.i(32 - n)));
      $.put(KA, $.call(this.kFn()));
      $.put(H, $.anew(this.I32A, $.i(8)));
      H256.forEach((h, i) => $.aset(this.I32A, $.l(H), $.i(i), $.i(h | 0)));
      $.put(W, $.anew(this.I32A, $.i(64)));
      // ceil((len + 9) / 64) blocks of the padded message
      $.put(NBLK, $.shrU($.add($.l(LEN), $.i(72)), $.i(6)));
      // the padded message's byte p: data, 0x80, zeros, the 64-bit bit length
      const byteAt = (p: X): X => () => {
        $.put(P, p);
        $.if($.lt($.l(P), $.l(LEN)), () => $.put(BV, $.agetU(this.B, $.l(BUF), $.add($.l(OFF), $.l(P)))), () => {
          $.if($.eq($.l(P), $.l(LEN)), () => $.put(BV, $.i(0x80)), () => {
            // the last 8 bytes carry len * 8 big-endian: the top three
            // bits of len land in byte -5, the rest in the last four
            $.put(T, $.sub($.shl($.l(NBLK), $.i(6)), $.l(P)));
            $.put(BV, $.sel(I32, $.le($.l(T), $.i(4)), $.and($.shrU($.shl($.l(LEN), $.i(3)), $.shl($.sub($.l(T), $.i(1)), $.i(3))), $.i(255)),
              $.sel(I32, $.eq($.l(T), $.i(5)), $.shrU($.l(LEN), $.i(29)), $.i(0))));
          });
        });
        $.do($.l(BV));
      };
      const [a, b, c, d, e, ff, g, h] = v as [number, number, number, number, number, number, number, number];
      $.for(BLK, $.i(0), $.l(NBLK), () => {
        $.for(J, $.i(0), $.i(16), () => {
          const base = $.add($.shl($.l(BLK), $.i(6)), $.shl($.l(J), $.i(2)));
          $.put(TMP, $.shl(byteAt(base), $.i(24)));
          $.put(TMP, $.or($.l(TMP), $.shl(byteAt($.add(base, $.i(1))), $.i(16))));
          $.put(TMP, $.or($.l(TMP), $.shl(byteAt($.add(base, $.i(2))), $.i(8))));
          $.put(TMP, $.or($.l(TMP), byteAt($.add(base, $.i(3)))));
          $.aset(this.I32A, $.l(W), $.l(J), $.l(TMP));
        });
        $.for(J, $.i(16), $.i(64), () => {
          const w = (k: number): X => $.aget(this.I32A, $.l(W), $.sub($.l(J), $.i(k)));
          // σ0(w[j-15]) and σ1(w[j-2])
          $.put(T1, w(15));
          $.put(T1, $.xor($.xor(rotr($.l(T1), 7), rotr($.l(T1), 18)), $.shrU($.l(T1), $.i(3))));
          $.put(T2, w(2));
          $.put(T2, $.xor($.xor(rotr($.l(T2), 17), rotr($.l(T2), 19)), $.shrU($.l(T2), $.i(10))));
          $.aset(this.I32A, $.l(W), $.l(J), $.add($.add(w(16), $.l(T1)), $.add(w(7), $.l(T2))));
        });
        v.forEach((loc, i) => $.put(loc, $.aget(this.I32A, $.l(H), $.i(i))));
        $.for(J, $.i(0), $.i(64), () => {
          // T1 = h + Σ1(e) + Ch(e, f, g) + K[j] + W[j]
          $.put(T1, $.add($.add($.l(h), $.xor($.xor(rotr($.l(e), 6), rotr($.l(e), 11)), rotr($.l(e), 25))),
            $.add($.xor($.and($.l(e), $.l(ff)), $.and($.xor($.l(e), $.i(-1)), $.l(g))),
              $.add($.aget(this.I32A, $.l(KA), $.l(J)), $.aget(this.I32A, $.l(W), $.l(J))))));
          // T2 = Σ0(a) + Maj(a, b, c)
          $.put(T2, $.add($.xor($.xor(rotr($.l(a), 2), rotr($.l(a), 13)), rotr($.l(a), 22)),
            $.xor($.xor($.and($.l(a), $.l(b)), $.and($.l(a), $.l(c))), $.and($.l(b), $.l(c)))));
          $.put(h, $.l(g));
          $.put(g, $.l(ff));
          $.put(ff, $.l(e));
          $.put(e, $.add($.l(d), $.l(T1)));
          $.put(d, $.l(c));
          $.put(c, $.l(b));
          $.put(b, $.l(a));
          $.put(a, $.add($.l(T1), $.l(T2)));
        });
        v.forEach((loc, i) => $.aset(this.I32A, $.l(H), $.i(i), $.add($.aget(this.I32A, $.l(H), $.i(i)), $.l(loc))));
      });
      $.do($.l(H));
    });
  }

  /** `(words) -> bytes<u8>` — big-endian digest words as bytes. */
  private wordBytesFn(): number {
    return this.fn("wordBytes", [this.ref(this.I32A)], [this.btRef], (f, $) => {
      const R = f.local(this.bRef);
      const I = f.local(I32);
      const N = f.local(I32);
      const V = f.local(I32);
      $.put(N, $.shl($.alen($.l(0)), $.i(2)));
      $.put(R, $.anew(this.B, $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(V, $.aget(this.I32A, $.l(0), $.shrU($.l(I), $.i(2))));
        $.aset(this.B, $.l(R), $.l(I), $.shrU($.l(V), $.shl($.sub($.i(3), $.and($.l(I), $.i(3))), $.i(3))));
      });
      $.do(this.wrap($, $.l(R), $.l(N)));
    });
  }

  /** `(alg, data, byteLength, enc) -> string` — the composed
   * createHash(alg).update(data).digest(enc): alg "sha256" | "sha1", enc
   * "hex" | "base64" (frontend-fenced literals). The data is a bytes value
   * of `byteLength` bytes from its offset. */
  hashDigestFn(): number {
    return this.fn("hashDigest", [this.sRef, this.btRef, I32, this.sRef], [this.sRef], (f, $) => {
      const [ALG, D, NB, ENC] = [0, 1, 2, 3];
      const WDS = f.local(this.ref(this.I32A));
      const DG = f.local(this.btRef);
      const buf = $.get(this.BT, 0, $.l(D));
      const off = $.get(this.BT, 1, $.l(D));
      $.put(WDS, $.sel(this.ref(this.I32A), $.eq($.alen($.l(ALG)), $.i(4)), $.call(this.x.sha1Fn(), buf, off, $.l(NB)), $.call(this.sha256Fn(), buf, off, $.l(NB))));
      $.put(DG, $.call(this.wordBytesFn(), $.l(WDS)));
      $.do(this.encode($, $.l(ENC), $.l(DG)));
    });
  }

  /* ── X509Certificate ──────────────────────────────────────────────── */

  /** `(bytes<u8>) -> der | null` — X509Pointer::Parse: the first PEM
   * certificate block, else the raw bytes as DER. Null sets errGlobal. */
  x509DerFn(): number {
    const x = this.x;
    return this.fn("x509Der", [this.btRef], [this.btRef], (f, $) => {
      const D = 0;
      const R = f.local(this.bRef);
      const C = f.local(this.btRef);
      const DERS = f.local(this.ref(x.BA));
      const E = f.local(I32);
      // the bytes from offset 0, as the PEM reader reads them
      $.put(R, $.anew(this.B, $.get(this.BT, 2, $.l(D))));
      $.do($.l(R), $.i(0), $.get(this.BT, 0, $.l(D)), $.get(this.BT, 1, $.l(D)), $.get(this.BT, 2, $.l(D)));
      f.c.arrayCopy(this.B, this.B);
      $.put(C, this.wrap($, $.l(R), $.get(this.BT, 2, $.l(D))));
      $.put(DERS, $.call(x.pemReadFn(true), $.l(R), $.get(this.BT, 2, $.l(D))));
      $.put(E, $.g(x.errGlobal()));
      $.gput(this.errGlobal(), $.l(E));
      $.if($.ne($.l(E), $.i(0)), () => $.ret($.nul(this.BT)));
      $.if($.notNull($.l(DERS)), () => $.ret($.aget(x.BA, $.l(DERS), $.i(0))));
      // no PEM certificate: d2i_X509_bio over the raw bytes (trailing
      // bytes are not read); its failure leaves PEM's error first in the
      // queue, so Node reports "no start line"
      $.put(C, $.call(x.certTlvFn(), $.l(C)));
      $.if($.isNull($.l(C)), () => {
        $.gput(this.errGlobal(), $.sel(I32, $.eq($.g(x.errGlobal()), $.i(PEM_NONCANON)), $.i(PEM_NONCANON), $.i(X509_NO_START)));
      });
      $.do($.l(C));
    });
  }

  /** `(bytes<u8>) -> string | null` — .fingerprint: the SHA-1 of the DER,
   * uppercase hex pairs joined by ':'. */
  fingerprintFn(): number {
    return this.fn("fingerprint", [this.btRef], [this.sRef], (f, $) => {
      const DER = f.local(this.btRef);
      const H = f.local(this.ref(this.I32A));
      const R = f.local(this.sRef);
      const I = f.local(I32);
      const V = f.local(I32);
      $.put(DER, $.call(this.x509DerFn(), $.l(0)));
      $.if($.isNull($.l(DER)), () => $.ret($.nul(this.S)));
      $.put(H, $.call(this.x.sha1Fn(), $.get(this.BT, 0, $.l(DER)), $.get(this.BT, 1, $.l(DER)), $.get(this.BT, 2, $.l(DER))));
      $.put(R, $.anew(this.S, $.i(59)));
      const hexd = (v: X): X => $.sel(I32, $.lt(v, $.i(10)), $.add(v, $.i(48)), $.add(v, $.i(55)));
      $.for(I, $.i(0), $.i(20), () => {
        $.put(V, $.and($.shrU($.aget(this.I32A, $.l(H), $.shrU($.l(I), $.i(2))), $.shl($.sub($.i(3), $.and($.l(I), $.i(3))), $.i(3))), $.i(255)));
        $.aset(this.S, $.l(R), $.mul($.l(I), $.i(3)), hexd($.shrU($.l(V), $.i(4))));
        $.aset(this.S, $.l(R), $.add($.mul($.l(I), $.i(3)), $.i(1)), hexd($.and($.l(V), $.i(15))));
        $.if($.lt($.l(I), $.i(19)), () => $.aset(this.S, $.l(R), $.add($.mul($.l(I), $.i(3)), $.i(2)), $.i(58)));
      });
      $.do($.l(R));
    });
  }

  /** `(bytes<u8>) -> string | null` — .validFrom (notAfter when `to`). */
  validityFn(to: boolean): number {
    return this.fn(to ? "validTo" : "validFrom", [this.btRef], [this.sRef], (f, $) => {
      const DER = f.local(this.btRef);
      const BUF = f.local(this.bRef);
      const P = f.local(I32);
      const END = f.local(I32);
      const HL = f.local(I32);
      const CL = f.local(I32);
      const R = f.local(this.sRef);
      $.put(DER, $.call(this.x509DerFn(), $.l(0)));
      $.if($.isNull($.l(DER)), () => $.ret($.nul(this.S)));
      $.put(BUF, $.get(this.BT, 0, $.l(DER)));
      $.put(P, $.get(this.BT, 1, $.l(DER)));
      $.put(END, $.add($.l(P), $.get(this.BT, 2, $.l(DER))));
      // certTlv has checked every TLV on this path, so each read is
      // well-formed and definite
      const tlv = (): void => {
        $.do($.call(this.x.tlvFn(), $.l(BUF), $.l(P), $.l(END)));
        f.c.localSet(CL);
        f.c.localSet(HL);
      };
      const enter = (): void => {
        tlv();
        $.put(P, $.add($.l(P), $.l(HL)));
      };
      const skip = (): void => {
        tlv();
        $.put(P, $.add($.add($.l(P), $.l(HL)), $.l(CL)));
      };
      enter(); // Certificate
      enter(); // tbsCertificate
      $.if($.eq($.agetU(this.B, $.l(BUF), $.l(P)), $.i(0xa0)), () => skip()); // version
      skip(); // serialNumber
      skip(); // signature
      skip(); // issuer
      enter(); // validity
      if (to) skip(); // notBefore
      tlv();
      $.put(R, $.call(this.timePrintFn(), $.l(BUF), $.agetU(this.B, $.l(BUF), $.l(P)), $.add($.l(P), $.l(HL)), $.l(CL)));
      $.if($.isNull($.l(R)), () => $.gput(this.errGlobal(), $.i(X509_BAD_TIME)));
      $.do($.l(R));
    });
  }

  /** `(buf, tag, pos, len) -> string | null` — ASN1_TIME_print (RFC 822
   * flags) over a canonical RFC 5280 time: UTCTime YYMMDDHHMMSSZ (years
   * 50-99 are 19xx) or GeneralizedTime YYYYMMDDHHMMSSZ, every field in
   * ossl_asn1_time_to_tm's range. Anything else answers null (a fence). */
  private timePrintFn(): number {
    return this.fn("timePrint", [this.bRef, I32, I32, I32], [this.sRef], (f, $) => {
      const [BUF, TAG, POS, LEN] = [0, 1, 2, 3];
      const I = f.local(I32);
      const Y = f.local(I32);
      const MO = f.local(I32);
      const DD = f.local(I32);
      const HH = f.local(I32);
      const MI = f.local(I32);
      const SS = f.local(I32);
      const Q = f.local(I32); // the month/day/... fields' start
      const MD = f.local(I32);
      const R = f.local(this.sRef);
      const O = f.local(I32);
      const T = f.local(I32);
      const at = (k: X): X => $.agetU(this.B, $.l(BUF), $.add($.l(POS), k));
      const two = (k: X): X => $.add($.mul($.sub(at(k), $.i(48)), $.i(10)), $.sub(at($.add(k, $.i(1))), $.i(48)));
      $.if($.eq($.l(TAG), $.i(0x17)), () => {
        $.if($.ne($.l(LEN), $.i(13)), () => $.ret($.nul(this.S)));
      }, () => {
        $.if($.ne($.l(LEN), $.i(15)), () => $.ret($.nul(this.S)));
      });
      $.if($.ne(at($.sub($.l(LEN), $.i(1))), $.i(90)), () => $.ret($.nul(this.S)));
      $.for(I, $.i(0), $.sub($.l(LEN), $.i(1)), () => {
        $.if($.gtU($.sub(at($.l(I)), $.i(48)), $.i(9)), () => $.ret($.nul(this.S)));
      });
      $.if($.eq($.l(TAG), $.i(0x17)), () => {
        $.put(Y, two($.i(0)));
        $.put(Y, $.add($.l(Y), $.sel(I32, $.lt($.l(Y), $.i(50)), $.i(2000), $.i(1900))));
        $.put(Q, $.i(2));
      }, () => {
        $.put(Y, $.add($.mul(two($.i(0)), $.i(100)), two($.i(2))));
        $.put(Q, $.i(4));
      });
      $.put(MO, two($.l(Q)));
      $.put(DD, two($.add($.l(Q), $.i(2))));
      $.put(HH, two($.add($.l(Q), $.i(4))));
      $.put(MI, two($.add($.l(Q), $.i(6))));
      $.put(SS, two($.add($.l(Q), $.i(8))));
      $.if($.either($.lt($.l(MO), $.i(1)), $.gt($.l(MO), $.i(12))), () => $.ret($.nul(this.S)));
      $.if($.either($.gt($.l(HH), $.i(23)), $.either($.gt($.l(MI), $.i(59)), $.gt($.l(SS), $.i(59)))), () => $.ret($.nul(this.S)));
      // the month's days (February by the Gregorian leap rule)
      $.put(MD, $.sel(I32, $.eq($.l(MO), $.i(2)),
        $.sel(I32, $.call(this.leapFn(), $.l(Y)), $.i(29), $.i(28)),
        $.sel(I32, $.either($.either($.eq($.l(MO), $.i(4)), $.eq($.l(MO), $.i(6))), $.either($.eq($.l(MO), $.i(9)), $.eq($.l(MO), $.i(11)))), $.i(30), $.i(31))));
      $.if($.either($.lt($.l(DD), $.i(1)), $.gt($.l(DD), $.l(MD))), () => $.ret($.nul(this.S)));
      // "%s %2d %02d:%02d:%02d %d GMT": 3 + 1 + 2 + 1 + 8 + 1 + digits(year) + 4
      $.put(T, $.sel(I32, $.ge($.l(Y), $.i(1000)), $.i(4), $.sel(I32, $.ge($.l(Y), $.i(100)), $.i(3), $.sel(I32, $.ge($.l(Y), $.i(10)), $.i(2), $.i(1)))));
      $.put(R, $.anew(this.S, $.add($.i(20), $.l(T))));
      const put = (v: X): void => {
        $.aset(this.S, $.l(R), $.l(O), v);
        $.put(O, $.add($.l(O), $.i(1)));
      };
      const mon = (k: number): X => $.call(this.monthCharFn(), $.add($.mul($.sub($.l(MO), $.i(1)), $.i(3)), $.i(k)));
      put(mon(0));
      put(mon(1));
      put(mon(2));
      put($.i(32));
      put($.sel(I32, $.lt($.l(DD), $.i(10)), $.i(32), $.add($.i(48), $.call(this.div10Fn(), $.l(DD)))));
      put($.add($.i(48), $.call(this.mod10Fn(), $.l(DD))));
      put($.i(32));
      for (const [v, sep] of [[HH, 58], [MI, 58], [SS, 32]] as const) {
        put($.add($.i(48), $.call(this.div10Fn(), $.l(v))));
        put($.add($.i(48), $.call(this.mod10Fn(), $.l(v))));
        put($.i(sep));
      }
      // the year, most significant digit first
      $.put(I, $.sub($.add($.l(O), $.l(T)), $.i(1)));
      $.while($.ge($.l(I), $.l(O)), () => {
        $.aset(this.S, $.l(R), $.l(I), $.add($.i(48), $.call(this.mod10Fn(), $.l(Y))));
        $.put(Y, $.call(this.div10Fn(), $.l(Y)));
        $.put(I, $.sub($.l(I), $.i(1)));
      });
      $.put(O, $.add($.l(O), $.l(T)));
      for (const ch of " GMT") put($.i(ch.charCodeAt(0)));
      $.do($.l(R));
    });
  }

  private leapFn(): number {
    return this.fn("leap", [I32], [I32], (f, $) => {
      const rem = (n: number): X => () => {
        f.c.localGet(0);
        f.c.i32Const(n);
        f.c.i32RemU();
      };
      $.do($.andThen($.eq(rem(4), $.i(0)), $.orElse($.ne(rem(100), $.i(0)), $.eq(rem(400), $.i(0)))));
    });
  }

  private div10Fn(): number {
    return this.fn("div10", [I32], [I32], (f, $) => {
      $.do($.l(0), $.i(10));
      f.c.i32DivU();
    });
  }

  private mod10Fn(): number {
    return this.fn("mod10", [I32], [I32], (f, $) => {
      $.do($.l(0), $.i(10));
      f.c.i32RemU();
    });
  }

  /** `(k) -> char` — MONTHS[k]. */
  private monthCharFn(): number {
    return this.fn("monthChar", [I32], [I32], (f, $) => {
      // a small br_table-free lookup: 36 compares at most, never hot
      for (let k = 0; k < MONTHS.length; k++) {
        $.if($.eq($.l(0), $.i(k)), () => $.ret($.i(MONTHS.charCodeAt(k))));
      }
      $.do($.i(63));
    });
  }
}
