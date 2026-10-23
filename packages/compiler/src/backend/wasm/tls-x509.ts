/* INC-29 U4 — the certificate text the TLS tier needs in the module, so
 * that what Node computes from a certificate comes out Node-exact without
 * asking the host for anything but DER bytes (abi.ts tlsCall):
 *
 *   - PEM writing: OpenSSL's PEM_write_bio_X509 text (64-column lines,
 *     a trailing newline) and Node's bundled-root text (72-column lines,
 *     none) — tls.getCACertificates' strings.
 *   - PEM reading: OpenSSL 3.5.7's PEM_read_bio_X509 loop as Node's
 *     LoadCertsFromBIO drives it (crypto/pem/pem_lib.c get_name,
 *     get_header_and_data and sanitize_line in PEM_FLAG_EAY_COMPATIBLE
 *     mode; crypto/evp/encode.c EVP_DecodeUpdate / EVP_DecodeFinal) —
 *     tls.setDefaultCACertificates' parse, its errors included. Two
 *     things are not transcribed and answer a named fence instead: PEM
 *     header lines (Proc-Type / DEK-Info, or a blank line inside a block)
 *     and lines longer than BIO_gets' 254-byte chunk. d2i_X509 is checked
 *     at the certificate's outer structure only (SEMANTICS.md S090).
 *   - SHA-1, for X509_cmp's order (Node keeps the default set in a
 *     std::set ordered by it).
 *   - The X.509 fields tls.checkServerIdentity reads: the subject's CN
 *     values and the subjectAltName text exactly as Node prints it
 *     (ncrypto's PrintGeneralName: "DNS:", "email:", "URI:", "IP Address:"
 *     with %X groups), the DNS names and the canonicalized IP addresses.
 *   - inet_ntop / inet_pton for IPv6 (canonicalizeIP).
 *
 * SEMANTICS.md S090 registers where this tier and Node part. */
import { A, Fn, type X } from "./asm.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export interface X509Deps {
  strRef: () => ValType;
  strType: () => number;
  bufType: () => number;
  bytesType: () => number;
  /** `(bytes) -> string`, buf.toString('utf8'). */
  utf8Decode: () => number;
}

/* pemRead's outcome codes (the error global). */
export const PEM_OK = 0;
export const PEM_BAD_BASE64 = 1;
export const PEM_ASN1 = 2;
export const PEM_BAD_END_LINE = 3;
export const PEM_UNSUPPORTED = 4;
/** A certificate whose DER OpenSSL would re-encode (a non-minimal or
 * indefinite length below the outer SEQUENCE): fenced by name. */
export const PEM_NONCANON = 5;
/** First-only mode (crypto.ts's X509Certificate): bytes after the
 * certificate inside the PEM block, which d2i_X509_AUX would read as
 * X509_CERT_AUX trust data — fenced by name. */
export const PEM_TRAILING = 6;

/* x509Info's fields. */
export const XI_SAN = 0; // string, null = no subjectAltName extension
export const XI_DNS = 1; // string array
export const XI_DNS_N = 2;
export const XI_IPS = 3; // string array (canonicalized)
export const XI_IPS_N = 4;
export const XI_CN = 5; // string array
export const XI_CN_N = 6;
export const XI_BAD = 7; // i32: 0 ok, else a construct this tier does not read (a named fence)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** encode.c's data_ascii2bin. */
const ASCII2BIN = [
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe0, 0xf0, 0xff, 0xff, 0xf1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0x3e, 0xff, 0xf2, 0xff, 0x3f, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0xff, 0xff,
  0xff, 0x00, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
  0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
  0x31, 0x32, 0x33, 0xff, 0xff, 0xff, 0xff, 0xff,
];

const B64_ERROR = 0xff;
const B64_EOF = 0xf2;

export class X509Builder {
  private readonly fns = new Map<string, number>();
  private globalsField: { err: number; nc: number; a2b: number; b64: number; a2bArr: number; b64Arr: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: X509Deps,
  ) {}

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.x509.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }
  get S(): number {
    return this.deps.strType();
  }
  get B(): number {
    return this.deps.bufType();
  }
  private get sRef(): ValType {
    return this.deps.strRef();
  }
  private get bRef(): ValType {
    return this.ref(this.B);
  }
  get I32A(): number {
    return this.mb.arrayType(I32, true);
  }
  /** An array of strings. */
  get SA(): number {
    return this.mb.arrayType(this.sRef, true);
  }
  /** An array of bytes values. */
  get BA(): number {
    return this.mb.arrayType(this.ref(this.deps.bytesType()), true);
  }
  private get BT(): number {
    return this.deps.bytesType();
  }

  private g(): NonNullable<X509Builder["globalsField"]> {
    if (this.globalsField === null) {
      this.globalsField = {
        err: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
        // tlv saw a long-form length that is not minimal
        nc: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
        a2b: this.mb.internData(Uint8Array.from(ASCII2BIN)),
        b64: this.mb.internData(Uint8Array.from(B64, (ch) => ch.charCodeAt(0))),
        a2bArr: this.mb.addGlobal(this.ref(this.B), true, (w) => {
          w.u8(0xd0);
          w.sleb(this.B);
        }),
        b64Arr: this.mb.addGlobal(this.ref(this.B), true, (w) => {
          w.u8(0xd0);
          w.sleb(this.B);
        }),
      };
    }
    return this.globalsField;
  }

  /** A table interned into the data blob, as an i8 array (made once). */
  private tableFn(which: "a2b" | "b64"): number {
    return this.fn(`table.${which}`, [], [this.bRef], (f, $) => {
      const g = this.g();
      const arr = which === "a2b" ? g.a2bArr : g.b64Arr;
      $.if($.isNull($.g(arr)), () => {
        f.c.i32Const(which === "a2b" ? g.a2b : g.b64);
        f.c.i32Const(which === "a2b" ? ASCII2BIN.length : B64.length);
        f.c.arrayNewData(this.B, 0);
        f.c.globalSet(arr);
      });
      $.do($.g(arr));
    });
  }

  /** The pemRead outcome (PEM_*). */
  errGlobal(): number {
    return this.g().err;
  }

  /** x509Info's struct. */
  infoT(): number {
    return this.mb.openStructType("x509:info", [
      { storage: this.sRef, mutable: true },
      { storage: this.ref(this.SA), mutable: true },
      { storage: I32, mutable: true },
      { storage: this.ref(this.SA), mutable: true },
      { storage: I32, mutable: true },
      { storage: this.ref(this.SA), mutable: true },
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
    ]);
  }

  /* ── small pieces ─────────────────────────────────────────────────── */

  private byte($: A, buf: X, i: X): X {
    return $.agetU(this.B, buf, i);
  }

  /** `(sa, n, s) -> sa'` — push a string onto a growable string array. */
  saPushFn(): number {
    return this.fn("saPush", [this.ref(this.SA), I32, this.sRef], [this.ref(this.SA)], (f, $) => {
      const [A_, N, S] = [0, 1, 2];
      const NA = f.local(this.ref(this.SA));
      $.if($.isNull($.l(A_)), () => $.put(A_, $.anew(this.SA, $.i(4))));
      $.if($.geU($.l(N), $.alen($.l(A_))), () => {
        $.put(NA, $.anew(this.SA, $.shl($.alen($.l(A_)), $.i(1))));
        $.do($.l(NA), $.i(0), $.l(A_), $.i(0), $.l(N));
        f.c.arrayCopy(this.SA, this.SA);
        $.put(A_, $.l(NA));
      });
      $.aset(this.SA, $.l(A_), $.l(N), $.l(S));
      $.do($.l(A_));
    });
  }

  /** `(ba, n, bytes) -> ba'` */
  baPushFn(): number {
    return this.fn("baPush", [this.ref(this.BA), I32, this.ref(this.BT)], [this.ref(this.BA)], (f, $) => {
      const [A_, N, V] = [0, 1, 2];
      const NA = f.local(this.ref(this.BA));
      $.if($.isNull($.l(A_)), () => $.put(A_, $.anew(this.BA, $.i(4))));
      $.if($.geU($.l(N), $.alen($.l(A_))), () => {
        $.put(NA, $.anew(this.BA, $.shl($.alen($.l(A_)), $.i(1))));
        $.do($.l(NA), $.i(0), $.l(A_), $.i(0), $.l(N));
        f.c.arrayCopy(this.BA, this.BA);
        $.put(A_, $.l(NA));
      });
      $.aset(this.BA, $.l(A_), $.l(N), $.l(V));
      $.do($.l(A_));
    });
  }

  /** `(s1, s2) -> s` concatenation over raw string arrays. */
  private catFn(): number {
    return this.fn("cat", [this.sRef, this.sRef], [this.sRef], (f, $) => {
      const R = f.local(this.sRef);
      $.put(R, $.anew(this.S, $.add($.alen($.l(0)), $.alen($.l(1)))));
      $.do($.l(R), $.i(0), $.l(0), $.i(0), $.alen($.l(0)));
      f.c.arrayCopy(this.S, this.S);
      $.do($.l(R), $.alen($.l(0)), $.l(1), $.i(0), $.alen($.l(1)));
      f.c.arrayCopy(this.S, this.S);
      $.do($.l(R));
    });
  }

  /** A literal as a fresh string (no interning needed here). */
  private lit($: A, s: string): X {
    return () => {
      for (const ch of s) $.c.i32Const(ch.charCodeAt(0));
      $.c.arrayNewFixed(this.S, s.length);
    };
  }

  private cat($: A, ...parts: X[]): X {
    return () => {
      parts[0]!();
      for (let i = 1; i < parts.length; i++) {
        parts[i]!();
        $.c.call(this.catFn());
      }
    };
  }

  /** `(n) -> string` — a non-negative integer in decimal. */
  decFn(): number {
    return this.fn("dec", [I32], [this.sRef], (f, $) => {
      const N = 0;
      const D = f.local(I32);
      const T = f.local(I32);
      const R = f.local(this.sRef);
      const I = f.local(I32);
      $.put(T, $.l(N));
      $.put(D, $.i(1));
      $.while($.geU($.l(T), $.i(10)), () => {
        $.put(T, $.call(this.divU10Fn(), $.l(T)));
        $.put(D, $.add($.l(D), $.i(1)));
      });
      $.put(R, $.anew(this.S, $.l(D)));
      $.put(T, $.l(N));
      $.put(I, $.sub($.l(D), $.i(1)));
      $.while($.ge($.l(I), $.i(0)), () => {
        $.aset(this.S, $.l(R), $.l(I), $.add($.i(48), $.sub($.l(T), $.mul($.call(this.divU10Fn(), $.l(T)), $.i(10)))));
        $.put(T, $.call(this.divU10Fn(), $.l(T)));
        $.put(I, $.sub($.l(I), $.i(1)));
      });
      $.do($.l(R));
    });
  }

  private divU10Fn(): number {
    return this.fn("divU10", [I32], [I32], (f, $) => {
      $.do($.l(0), $.i(10));
      f.c.i32DivU();
    });
  }

  /** `(n, upper) -> string` — n in hex, no leading zeros (%X / %x). */
  hexFn(upper: boolean): number {
    return this.fn(upper ? "hexU" : "hexL", [I32], [this.sRef], (f, $) => {
      const N = 0;
      const D = f.local(I32);
      const R = f.local(this.sRef);
      const I = f.local(I32);
      const V = f.local(I32);
      $.put(D, $.i(1));
      $.while($.geU($.shrU($.l(N), $.shl($.l(D), $.i(2))), $.i(1)), () => {
        $.put(D, $.add($.l(D), $.i(1)));
        $.if($.eq($.l(D), $.i(8)), () => f.c.br(2)); // n < 2^32
      });
      $.put(R, $.anew(this.S, $.l(D)));
      $.for(I, $.i(0), $.l(D), () => {
        $.put(V, $.and($.shrU($.l(N), $.shl($.sub($.sub($.l(D), $.i(1)), $.l(I)), $.i(2))), $.i(15)));
        $.aset(this.S, $.l(R), $.l(I), $.sel(I32, $.lt($.l(V), $.i(10)), $.add($.l(V), $.i(48)), $.add($.l(V), $.i(upper ? 55 : 87))));
      });
      $.do($.l(R));
    });
  }

  /* ── PEM writing ──────────────────────────────────────────────────── */

  /** `(buf, off, len) -> string`: the DER as a CERTIFICATE PEM block,
   * base64 in `width`-column lines, a trailing newline when `nl`. */
  pemFn(width: number, nl: boolean): number {
    return this.fn(`pem${width}${nl ? "n" : ""}`, [this.bRef, I32, I32], [this.sRef], (f, $) => {
      const [BUF, OFF, LEN] = [0, 1, 2];
      const head = "-----BEGIN CERTIFICATE-----\n";
      const tail = "-----END CERTIFICATE-----" + (nl ? "\n" : "");
      const NB = f.local(I32);
      const NL = f.local(I32);
      const R = f.local(this.sRef);
      const P = f.local(I32);
      const I = f.local(I32);
      const COL = f.local(I32);
      const W = f.local(I32);
      const K = f.local(I32);
      const g = this.g();
      // 4 * ceil(len / 3) base64 chars, ceil(nb / width) lines.
      $.put(NB, $.mul($.i(4), $.call(this.divU3Fn(), $.add($.l(LEN), $.i(2)))));
      $.put(NL, $.call(this.divUFn(), $.add($.l(NB), $.i(width - 1)), $.i(width)));
      $.put(R, $.anew(this.S, $.add($.add($.l(NB), $.l(NL)), $.i(head.length + tail.length))));
      const put = (ch: X): void => {
        $.aset(this.S, $.l(R), $.l(P), ch);
        $.put(P, $.add($.l(P), $.i(1)));
      };
      for (const ch of head) put($.i(ch.charCodeAt(0)));
      const TB = f.local(this.bRef);
      $.put(TB, $.call(this.tableFn("b64")));
      void g;
      const b64 = (v: X): X => $.agetU(this.B, $.l(TB), v);
      const emit = (v: X): void => {
        put(b64(v));
        $.put(COL, $.add($.l(COL), $.i(1)));
        $.if($.eq($.l(COL), $.i(width)), () => {
          put($.i(10));
          $.put(COL, $.i(0));
        });
      };
      const at = (k: X): X => this.byte($, $.l(BUF), $.add($.l(OFF), k));
      $.while($.lt($.add($.l(I), $.i(2)), $.l(LEN)), () => {
        $.put(W, $.or($.or($.shl(at($.l(I)), $.i(16)), $.shl(at($.add($.l(I), $.i(1))), $.i(8))), at($.add($.l(I), $.i(2)))));
        emit($.shrU($.l(W), $.i(18)));
        emit($.and($.shrU($.l(W), $.i(12)), $.i(63)));
        emit($.and($.shrU($.l(W), $.i(6)), $.i(63)));
        emit($.and($.l(W), $.i(63)));
        $.put(I, $.add($.l(I), $.i(3)));
      });
      $.put(K, $.sub($.l(LEN), $.l(I)));
      $.if($.eq($.l(K), $.i(1)), () => {
        $.put(W, $.shl(at($.l(I)), $.i(16)));
        emit($.shrU($.l(W), $.i(18)));
        emit($.and($.shrU($.l(W), $.i(12)), $.i(63)));
        put($.i(61));
        $.put(COL, $.add($.l(COL), $.i(1)));
        $.if($.eq($.l(COL), $.i(width)), () => {
          put($.i(10));
          $.put(COL, $.i(0));
        });
        put($.i(61));
        $.put(COL, $.add($.l(COL), $.i(1)));
      });
      $.if($.eq($.l(K), $.i(2)), () => {
        $.put(W, $.or($.shl(at($.l(I)), $.i(16)), $.shl(at($.add($.l(I), $.i(1))), $.i(8))));
        emit($.shrU($.l(W), $.i(18)));
        emit($.and($.shrU($.l(W), $.i(12)), $.i(63)));
        emit($.and($.shrU($.l(W), $.i(6)), $.i(63)));
        put($.i(61));
        $.put(COL, $.add($.l(COL), $.i(1)));
      });
      $.if($.ne($.l(COL), $.i(0)), () => put($.i(10)));
      for (const ch of tail) put($.i(ch.charCodeAt(0)));
      $.do($.l(R));
    });
  }

  private divU3Fn(): number {
    return this.fn("divU3", [I32], [I32], (f, $) => {
      $.do($.l(0), $.i(3));
      f.c.i32DivU();
    });
  }

  private divUFn(): number {
    return this.fn("divU", [I32, I32], [I32], (f, $) => {
      $.do($.l(0), $.l(1));
      f.c.i32DivU();
    });
  }

  /* ── SHA-1 ────────────────────────────────────────────────────────── */

  /** `(buf, off, len) -> i32[5]` — the digest's five big-endian words. */
  sha1Fn(): number {
    return this.fn("sha1", [this.bRef, I32, I32], [this.ref(this.I32A)], (f, $) => {
      const [BUF, OFF, LEN] = [0, 1, 2];
      const H = f.local(this.ref(this.I32A));
      const W = f.local(this.ref(this.I32A));
      const BLK = f.local(I32);
      const NBLK = f.local(I32);
      const T = f.local(I32);
      const J = f.local(I32);
      const P = f.local(I32);
      const BV = f.local(I32);
      const a = f.local(I32);
      const b = f.local(I32);
      const c = f.local(I32);
      const d = f.local(I32);
      const e = f.local(I32);
      const FV = f.local(I32);
      const KV = f.local(I32);
      const TMP = f.local(I32);
      const rotl = (x: X, n: number): X => $.or($.shl(x, $.i(n)), $.shrU(x, $.i(32 - n)));
      $.put(H, $.anew(this.I32A, $.i(5)));
      [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0].forEach((v, i) => $.aset(this.I32A, $.l(H), $.i(i), $.i(v | 0)));
      $.put(W, $.anew(this.I32A, $.i(80)));
      // ceil((len + 9) / 64) blocks of the padded message.
      $.put(NBLK, $.shrU($.add($.l(LEN), $.i(72)), $.i(6)));
      // the padded message's byte p: data, 0x80, zeros, the 64-bit bit length
      const byteAt = (p: X): X => () => {
        $.put(P, p);
        $.if($.lt($.l(P), $.l(LEN)), () => $.put(BV, this.byte($, $.l(BUF), $.add($.l(OFF), $.l(P)))), () => {
          $.if($.eq($.l(P), $.l(LEN)), () => $.put(BV, $.i(0x80)), () => {
            // the last 8 bytes carry len * 8 big-endian (len < 2^29 here)
            $.put(T, $.sub($.shl($.l(NBLK), $.i(6)), $.l(P)));
            $.put(BV, $.sel(I32, $.le($.l(T), $.i(4)), $.and($.shrU($.shl($.l(LEN), $.i(3)), $.shl($.sub($.l(T), $.i(1)), $.i(3))), $.i(255)), $.i(0)));
          });
        });
        $.do($.l(BV));
      };
      $.for(BLK, $.i(0), $.l(NBLK), () => {
        $.for(J, $.i(0), $.i(16), () => {
          const base = $.add($.shl($.l(BLK), $.i(6)), $.shl($.l(J), $.i(2)));
          $.put(TMP, $.shl(byteAt(base), $.i(24)));
          $.put(TMP, $.or($.l(TMP), $.shl(byteAt($.add(base, $.i(1))), $.i(16))));
          $.put(TMP, $.or($.l(TMP), $.shl(byteAt($.add(base, $.i(2))), $.i(8))));
          $.put(TMP, $.or($.l(TMP), byteAt($.add(base, $.i(3)))));
          $.aset(this.I32A, $.l(W), $.l(J), $.l(TMP));
        });
        $.for(J, $.i(16), $.i(80), () => {
          const w = (k: number): X => $.aget(this.I32A, $.l(W), $.sub($.l(J), $.i(k)));
          $.put(TMP, $.xor($.xor(w(3), w(8)), $.xor(w(14), w(16))));
          $.aset(this.I32A, $.l(W), $.l(J), rotl($.l(TMP), 1));
        });
        $.put(a, $.aget(this.I32A, $.l(H), $.i(0)));
        $.put(b, $.aget(this.I32A, $.l(H), $.i(1)));
        $.put(c, $.aget(this.I32A, $.l(H), $.i(2)));
        $.put(d, $.aget(this.I32A, $.l(H), $.i(3)));
        $.put(e, $.aget(this.I32A, $.l(H), $.i(4)));
        $.for(J, $.i(0), $.i(80), () => {
          $.if($.lt($.l(J), $.i(20)), () => {
            $.put(FV, $.or($.and($.l(b), $.l(c)), $.and($.xor($.l(b), $.i(-1)), $.l(d))));
            $.put(KV, $.i(0x5a827999));
          }, () => {
            $.if($.lt($.l(J), $.i(40)), () => {
              $.put(FV, $.xor($.xor($.l(b), $.l(c)), $.l(d)));
              $.put(KV, $.i(0x6ed9eba1));
            }, () => {
              $.if($.lt($.l(J), $.i(60)), () => {
                $.put(FV, $.or($.or($.and($.l(b), $.l(c)), $.and($.l(b), $.l(d))), $.and($.l(c), $.l(d))));
                $.put(KV, $.i(0x8f1bbcdc | 0));
              }, () => {
                $.put(FV, $.xor($.xor($.l(b), $.l(c)), $.l(d)));
                $.put(KV, $.i(0xca62c1d6 | 0));
              });
            });
          });
          $.put(TMP, $.add($.add($.add(rotl($.l(a), 5), $.l(FV)), $.add($.l(e), $.l(KV))), $.aget(this.I32A, $.l(W), $.l(J))));
          $.put(e, $.l(d));
          $.put(d, $.l(c));
          $.put(c, rotl($.l(b), 30));
          $.put(b, $.l(a));
          $.put(a, $.l(TMP));
        });
        [a, b, c, d, e].forEach((v, i) => $.aset(this.I32A, $.l(H), $.i(i), $.add($.aget(this.I32A, $.l(H), $.i(i)), $.l(v))));
      });
      $.do($.l(H));
    });
  }

  /** `(h1, h2) -> -1 | 0 | 1` — memcmp of two digests. */
  sha1CmpFn(): number {
    return this.fn("sha1Cmp", [this.ref(this.I32A), this.ref(this.I32A)], [I32], (f, $) => {
      const I = f.local(I32);
      const A1 = f.local(I32);
      const A2 = f.local(I32);
      $.for(I, $.i(0), $.i(5), () => {
        $.put(A1, $.aget(this.I32A, $.l(0), $.l(I)));
        $.put(A2, $.aget(this.I32A, $.l(1), $.l(I)));
        $.if($.ltU($.l(A1), $.l(A2)), () => $.ret($.i(-1)));
        $.if($.gtU($.l(A1), $.l(A2)), () => $.ret($.i(1)));
      });
      $.do($.i(0));
    });
  }

  /* ── PEM reading (OpenSSL's PEM_read_bio_X509 loop) ───────────────── */

  /** `(buf, len) -> bytes[]` (the DER of each certificate, in order;
   * null with the error global set). The count is the array's non-null
   * prefix.
   *
   * `first` is PEM_read_bio_X509_AUX's single read instead (ncrypto's
   * X509Pointer::Parse, crypto.ts): it stops at the first certificate,
   * also takes the TRUSTED CERTIFICATE name, and fences what that read
   * does differently from the loop: an empty block (PEM_UNSUPPORTED),
   * bytes after the certificate (PEM_TRAILING, the AUX trust data) and an
   * indefinite outer length (PEM_NONCANON). A DER failure is PEM_ASN1
   * (its text is the ASN.1 decoder's reason, which this tier does not
   * model). No certificate block at all answers null with PEM_OK. */
  pemReadFn(first = false): number {
    return this.fn(first ? "pemRead1" : "pemRead", [this.bRef, I32], [this.ref(this.BA)], (f, $) => {
      const [BUF, LEN] = [0, 1];
      const POS = f.local(I32);
      const OUT = f.local(this.ref(this.BA));
      const N = f.local(I32);
      const LS = f.local(I32); // line start
      const LL = f.local(I32); // BIO_gets' count
      const K = f.local(I32); // sanitized length (without the '\n')
      const FIRST = f.local(I32);
      const NAME0 = f.local(I32); // the name's bounds in buf
      const NAMEN = f.local(I32);
      const D = f.local(this.bRef); // the data lines
      const DN = f.local(I32);
      const DER = f.local(this.ref(this.BT));
      const ISCERT = f.local(I32);
      const I = f.local(I32);
      const LB = f.local(I32); // sanitized line's first byte offset (after a BOM)
      const PARTIAL = f.local(I32);
      const TMPB = f.local(this.bRef);
      const g = this.g();
      const fail = (code: number): void => {
        $.gput(g.err, $.i(code));
        $.ret($.nul(this.BA));
      };
      $.gput(g.err, $.i(PEM_OK));
      // BIO_gets(bp, linebuf, 255): up to 254 bytes, through a '\n'.
      const gets = (): void => {
        $.put(LS, $.l(POS));
        $.put(LL, $.i(0));
        f.c.block();
        f.c.loop();
        $.if($.either($.ge($.add($.l(LS), $.l(LL)), $.l(LEN)), $.ge($.l(LL), $.i(254))), () => f.c.br(2));
        $.put(LL, $.add($.l(LL), $.i(1)));
        $.if($.eq(this.byte($, $.l(BUF), $.sub($.add($.l(LS), $.l(LL)), $.i(1))), $.i(10)), () => f.c.br(2));
        f.c.br(0);
        f.c.end();
        f.c.end();
        $.put(POS, $.add($.l(POS), $.l(LL)));
      };
      // sanitize_line (PEM_FLAG_EAY_COMPATIBLE): a UTF-8 BOM dropped on a
      // name search's first line, then every trailing byte that is <= ' '
      // as a (signed) char — controls, spaces and every byte >= 0x80.
      const sanitize = (first: boolean): void => {
        $.put(LB, $.l(LS));
        if (first) {
          $.if($.l(FIRST), () => {
            $.if($.andThen($.gt($.l(LL), $.i(3)), $.andThen($.eq(this.byte($, $.l(BUF), $.l(LS)), $.i(0xef)), $.andThen($.eq(this.byte($, $.l(BUF), $.add($.l(LS), $.i(1))), $.i(0xbb)), $.eq(this.byte($, $.l(BUF), $.add($.l(LS), $.i(2))), $.i(0xbf))))), () => {
              $.put(LB, $.add($.l(LS), $.i(3)));
              $.put(LL, $.sub($.l(LL), $.i(3)));
            });
          });
        }
        $.put(K, $.l(LL));
        $.while($.andThen($.gt($.l(K), $.i(0)), $.call(this.lowFn(), this.byte($, $.l(BUF), $.add($.l(LB), $.sub($.l(K), $.i(1)))))), () => $.put(K, $.sub($.l(K), $.i(1))));
      };
      // the sanitized line (bytes [LB, LB + K) then '\n') starts with `s`
      const startsWith = (s: string, at: X = $.i(0)): X => {
        let x: X = $.ge($.sub($.add($.l(K), $.i(1)), at), $.i(s.length));
        for (let i = 0; i < s.length; i++) {
          const want = s.charCodeAt(i);
          const prev = x;
          const idx = $.add(at, $.i(i));
          x = $.andThen(prev, $.eq($.sel(I32, $.eq(idx, $.l(K)), $.i(10), this.byte($, $.l(BUF), $.add($.l(LB), idx))), $.i(want)));
        }
        return x;
      };
      $.while($.i(1), () => {
        // one PEM_read_bio_X509: pem_bytes_read_bio_flags' do-while
        $.put(ISCERT, $.i(0));
        $.while($.not($.l(ISCERT)), () => {
          // get_name
          $.put(FIRST, $.i(1));
          f.c.block();
          f.c.loop();
          gets();
          $.if($.le($.l(LL), $.i(0)), () => $.ret($.l(OUT))); // NO_START_LINE: done
          sanitize(true);
          $.put(FIRST, $.i(0));
          // "-----BEGIN " ... "-----\n"
          $.if($.andThen(startsWith("-----BEGIN "), $.andThen($.ge($.add($.l(K), $.i(1)), $.i(6)), startsWith("-----\n", $.sub($.add($.l(K), $.i(1)), $.i(6))))), () => f.c.br(2));
          f.c.br(0);
          f.c.end();
          f.c.end();
          $.put(NAME0, $.add($.l(LB), $.i(11)));
          $.put(NAMEN, $.sub($.sub($.add($.l(K), $.i(1)), $.i(6)), $.i(11)));
          // get_header_and_data
          $.put(D, $.anew(this.B, $.i(256)));
          $.put(DN, $.i(0));
          $.put(PARTIAL, $.i(0));
          f.c.block();
          f.c.loop();
          gets();
          $.if($.le($.l(LL), $.i(0)), () => fail(PEM_BAD_END_LINE));
          // A line BIO_gets cut at 254 bytes, or the line after one.
          $.if($.l(PARTIAL), () => fail(PEM_UNSUPPORTED));
          $.put(PARTIAL, $.andThen($.eq($.l(LL), $.i(254)), $.ne(this.byte($, $.l(BUF), $.add($.l(LS), $.i(253))), $.i(10))));
          // a ':' anywhere: a header line (Proc-Type / DEK-Info).
          $.for(I, $.i(0), $.l(LL), () => {
            $.if($.eq(this.byte($, $.l(BUF), $.add($.l(LS), $.l(I))), $.i(58)), () => fail(PEM_UNSUPPORTED));
          });
          sanitize(false);
          // a blank line: the header separator
          $.if($.eq($.l(K), $.i(0)), () => fail(PEM_UNSUPPORTED));
          $.if(startsWith("-----END "), () => {
            // the name, then "-----\n"
            $.if($.not($.call(this.nameEndFn(), $.l(BUF), $.l(LB), $.l(K), $.l(NAME0), $.l(NAMEN))), () => fail(PEM_BAD_END_LINE));
            f.c.br(2);
          });
          // a data line: through its '\n'
          $.while($.gt($.add($.add($.l(DN), $.l(K)), $.i(1)), $.alen($.l(D))), () => {
            $.put(I, $.l(DN));
            $.do($.anew(this.B, $.shl($.alen($.l(D)), $.i(1))));
            f.c.localTee(TMPB);
            $.do($.i(0), $.l(D), $.i(0), $.l(DN));
            f.c.arrayCopy(this.B, this.B);
            $.put(D, $.l(TMPB));
          });
          $.do($.l(D), $.l(DN), $.l(BUF), $.l(LB), $.l(K));
          f.c.arrayCopy(this.B, this.B);
          $.aset(this.B, $.l(D), $.add($.l(DN), $.l(K)), $.i(10));
          $.put(DN, $.add($.add($.l(DN), $.l(K)), $.i(1)));
          f.c.br(0);
          f.c.end();
          f.c.end();
          // no data at all: PEM_read_bio_ex answers 0 with nothing queued,
          // so Node's loop stops here, successfully.
          if (first) $.if($.eq($.l(DN), $.i(0)), () => fail(PEM_UNSUPPORTED));
          else $.if($.eq($.l(DN), $.i(0)), () => $.ret($.l(OUT)));
          $.put(DER, $.call(this.decodeFn(), $.l(D), $.l(DN)));
          $.if($.isNull($.l(DER)), () => fail(PEM_BAD_BASE64));
          // a block that decodes to nothing ends the read, successfully
          // (PEM_read_bio answers no data; Node's loop stops there)
          if (first) $.if($.not($.get(this.BT, 2, $.l(DER))), () => fail(PEM_UNSUPPORTED));
          else $.if($.not($.get(this.BT, 2, $.l(DER))), () => $.ret($.l(OUT)));
          // check_pem(nm, PEM_STRING_X509): "CERTIFICATE" or "X509 CERTIFICATE"
          // (PEM_STRING_X509_TRUSTED adds "TRUSTED CERTIFICATE")
          $.put(ISCERT, $.call(this.isCertNameFn(first), $.l(BUF), $.l(NAME0), $.l(NAMEN)));
        });
        if (first) {
          // d2i_X509_AUX reads what follows the certificate as trust data
          $.do($.call(this.tlvFn(), $.get(this.BT, 0, $.l(DER)), $.get(this.BT, 1, $.l(DER)), $.add($.get(this.BT, 1, $.l(DER)), $.get(this.BT, 2, $.l(DER)))));
          f.c.localSet(I);
          f.c.localSet(K);
          $.if($.eq($.l(K), $.i(-2)), () => fail(PEM_NONCANON));
          $.if($.andThen($.ge($.l(K), $.i(0)), $.ne($.add($.l(K), $.l(I)), $.get(this.BT, 2, $.l(DER)))), () => fail(PEM_TRAILING));
        }
        // d2i_X509: the certificate's outer structure
        $.put(DER, $.call(this.certTlvFn(), $.l(DER)));
        $.if($.isNull($.l(DER)), () => {
          $.if($.eq($.g(g.err), $.i(PEM_NONCANON)), () => $.ret($.nul(this.BA)));
          fail(PEM_ASN1);
        });
        $.put(OUT, $.call(this.baPushFn(), $.l(OUT), $.l(N), $.l(DER)));
        if (first) $.ret($.l(OUT));
        $.put(N, $.add($.l(N), $.i(1)));
      });
      $.do($.l(OUT));
      // (unreachable, but the validator wants a value)
    });
  }

  /** A byte that sanitize_line strips from a line's end. */
  private lowFn(): number {
    return this.fn("low", [I32], [I32], (f, $) => $.do($.either($.le($.l(0), $.i(32)), $.ge($.l(0), $.i(128)))));
  }

  /** The END line names the BEGIN line's name, then "-----\n". */
  private nameEndFn(): number {
    return this.fn("nameEnd", [this.bRef, I32, I32, I32, I32], [I32], (f, $) => {
      const [BUF, LB, K, N0, NN] = [0, 1, 2, 3, 4];
      const I = f.local(I32);
      // "-----END " (9) + name + "-----" then the '\n' at K
      $.if($.ne($.l(K), $.add($.add($.i(9), $.l(NN)), $.i(5))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.l(NN), () => {
        $.if($.ne(this.byte($, $.l(BUF), $.add($.add($.l(LB), $.i(9)), $.l(I))), this.byte($, $.l(BUF), $.add($.l(N0), $.l(I)))), () => $.ret($.i(0)));
      });
      $.for(I, $.i(0), $.i(5), () => {
        $.if($.ne(this.byte($, $.l(BUF), $.add($.add($.add($.l(LB), $.i(9)), $.l(NN)), $.l(I))), $.i(45)), () => $.ret($.i(0)));
      });
      $.do($.i(1));
    });
  }

  private isCertNameFn(trusted = false): number {
    return this.fn(trusted ? "isCertName1" : "isCertName", [this.bRef, I32, I32], [I32], (f, $) => {
      const [BUF, N0, NN] = [0, 1, 2];
      const I = f.local(I32);
      const eqAt = (s: string, off: number): X => {
        let x: X = $.i(1);
        for (let i = 0; i < s.length; i++) {
          const prev = x;
          x = $.andThen(prev, $.eq(this.byte($, $.l(BUF), $.add($.l(N0), $.i(off + i))), $.i(s.charCodeAt(i))));
        }
        return x;
      };
      void I;
      $.if($.eq($.l(NN), $.i(11)), () => $.ret(eqAt("CERTIFICATE", 0)));
      $.if($.eq($.l(NN), $.i(16)), () => $.ret(eqAt("X509 CERTIFICATE", 0)));
      if (trusted) $.if($.eq($.l(NN), $.i(19)), () => $.ret(eqAt("TRUSTED CERTIFICATE", 0)));
      $.do($.i(0));
    });
  }

  /** `(data, n) -> bytes | null` — EVP_DecodeUpdate over the whole data
   * then EVP_DecodeFinal (null = PEM_R_BAD_BASE64_DECODE). */
  decodeFn(): number {
    return this.fn("decode", [this.bRef, I32], [this.ref(this.BT)], (f, $) => {
      const [IN, INL] = [0, 1];
      const OUT = f.local(this.bRef);
      const OL = f.local(I32);
      const DB = f.local(this.bRef); // enc_data (64)
      const N = f.local(I32);
      const EOF = f.local(I32);
      const SEOF = f.local(I32);
      const I = f.local(I32);
      const TMP = f.local(I32);
      const V = f.local(I32);
      const R = f.local(I32);
      $.put(OUT, $.anew(this.B, $.add($.l(INL), $.i(4))));
      $.put(DB, $.anew(this.B, $.i(64)));
      // the update over every byte (the data BIO is one chunk)
      f.c.block(); // tail
      $.for(I, $.i(0), $.l(INL), () => {
        $.put(TMP, this.byte($, $.l(IN), $.l(I)));
        $.put(V, $.call(this.a2bFn(), $.l(TMP)));
        $.if($.eq($.l(V), $.i(B64_ERROR)), () => $.ret($.nul(this.BT)));
        $.if($.eq($.l(TMP), $.i(61)), () => $.put(EOF, $.add($.l(EOF), $.i(1))), () => {
          $.if($.both($.gt($.l(EOF), $.i(0)), $.call(this.isB64Fn(), $.l(V))), () => $.ret($.nul(this.BT)));
        });
        $.if($.gt($.l(EOF), $.i(2)), () => $.ret($.nul(this.BT)));
        $.if($.eq($.l(V), $.i(B64_EOF)), () => {
          $.put(SEOF, $.i(1));
          f.c.br(3); // to tail (if, loop-block... see for: block>loop>if)
        });
        $.if($.call(this.isB64Fn(), $.l(V)), () => {
          $.aset(this.B, $.l(DB), $.l(N), $.l(TMP));
          $.put(N, $.add($.l(N), $.i(1)));
        });
        $.if($.eq($.l(N), $.i(64)), () => {
          $.put(R, $.call(this.blockFn(), $.l(DB), $.l(N), $.l(EOF), $.l(OUT), $.l(OL)));
          $.put(N, $.i(0));
          $.if($.either($.lt($.l(R), $.i(0)), $.both($.eq($.l(R), $.i(0)), $.gt($.l(EOF), $.i(0)))), () => $.ret($.nul(this.BT)));
          $.put(OL, $.add($.l(OL), $.l(R)));
        });
      });
      f.c.end();
      // tail
      $.if($.gt($.l(N), $.i(0)), () => {
        $.if($.eq($.and($.l(N), $.i(3)), $.i(0)), () => {
          $.put(R, $.call(this.blockFn(), $.l(DB), $.l(N), $.l(EOF), $.l(OUT), $.l(OL)));
          $.put(N, $.i(0));
          $.if($.either($.lt($.l(R), $.i(0)), $.both($.eq($.l(R), $.i(0)), $.gt($.l(EOF), $.i(0)))), () => $.ret($.nul(this.BT)));
          $.put(OL, $.add($.l(OL), $.l(R)));
        }, () => {
          $.if($.l(SEOF), () => $.ret($.nul(this.BT)));
        });
      });
      // EVP_DecodeFinal
      $.if($.ne($.l(N), $.i(0)), () => {
        $.put(R, $.call(this.blockFn(), $.l(DB), $.l(N), $.i(-1), $.l(OUT), $.l(OL)));
        $.if($.lt($.l(R), $.i(0)), () => $.ret($.nul(this.BT)));
        $.put(OL, $.add($.l(OL), $.l(R)));
      });
      $.do($.new_(this.BT, $.raw((c) => {
        c.localGet(OUT);
        c.refAsNonNull();
      }), $.i(0), $.l(OL)));
    });
  }

  private a2bFn(): number {
    return this.fn("a2b", [I32], [I32], (f, $) => {
      $.if($.geU($.l(0), $.i(128)), () => $.ret($.i(B64_ERROR)));
      $.do($.agetU(this.B, $.call(this.tableFn("a2b")), $.l(0)));
    });
  }

  /** B64_BASE64(v) */
  private isB64Fn(): number {
    return this.fn("isB64", [I32], [I32], (f, $) => $.do($.ne($.or($.l(0), $.i(0x13)), $.i(0xf3))));
  }

  /** evp_decodeblock_int(ctx, out + ol, d, n, eof) -> decoded | -1 */
  private blockFn(): number {
    return this.fn("block", [this.bRef, I32, I32, this.bRef, I32], [I32], (f, $) => {
      const [DB, N0, EOF0, OUT, OL] = [0, 1, 2, 3, 4];
      const F = f.local(I32);
      const N = f.local(I32);
      const EOF = f.local(I32);
      const I = f.local(I32);
      const T = f.local(I32);
      const RET = f.local(I32);
      const A1 = f.local(I32);
      const B1 = f.local(I32);
      const C1 = f.local(I32);
      const D1 = f.local(I32);
      const L = f.local(I32);
      const CC = f.local(I32);
      const DD = f.local(I32);
      $.put(N, $.l(N0));
      $.put(EOF, $.l(EOF0));
      $.put(T, $.l(OL));
      const at = (k: X): X => $.call(this.a2bFn(), this.byte($, $.l(DB), k));
      // leading whitespace
      $.while($.andThen($.gt($.l(N), $.i(0)), $.eq(at($.l(F)), $.i(0xe0))), () => {
        $.put(F, $.add($.l(F), $.i(1)));
        $.put(N, $.sub($.l(N), $.i(1)));
      });
      // trailing non-base64
      $.while($.andThen($.gt($.l(N), $.i(3)), $.not($.call(this.isB64Fn(), at($.sub($.add($.l(F), $.l(N)), $.i(1)))))), () => $.put(N, $.sub($.l(N), $.i(1))));
      $.if($.ne($.and($.l(N), $.i(3)), $.i(0)), () => $.ret($.i(-1)));
      $.if($.eq($.l(N), $.i(0)), () => $.ret($.i(0)));
      const quad = (): void => {
        $.put(A1, at($.l(F)));
        $.put(B1, at($.add($.l(F), $.i(1))));
        $.put(C1, at($.add($.l(F), $.i(2))));
        $.put(D1, at($.add($.l(F), $.i(3))));
        $.put(CC, this.byte($, $.l(DB), $.add($.l(F), $.i(2))));
        $.put(DD, this.byte($, $.l(DB), $.add($.l(F), $.i(3))));
        $.put(F, $.add($.l(F), $.i(4)));
        $.if($.ne($.and($.or($.or($.l(A1), $.l(B1)), $.or($.l(C1), $.l(D1))), $.i(0x80)), $.i(0)), () => $.ret($.i(-1)));
        $.put(L, $.or($.or($.shl($.l(A1), $.i(18)), $.shl($.l(B1), $.i(12))), $.or($.shl($.l(C1), $.i(6)), $.l(D1))));
      };
      const out = (v: X): void => {
        $.aset(this.B, $.l(OUT), $.l(T), $.and(v, $.i(255)));
        $.put(T, $.add($.l(T), $.i(1)));
      };
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.sub($.l(N), $.i(4))), () => {
        quad();
        out($.shrU($.l(L), $.i(16)));
        out($.shrU($.l(L), $.i(8)));
        out($.l(L));
        $.put(RET, $.add($.l(RET), $.i(3)));
        $.put(I, $.add($.l(I), $.i(4)));
      });
      quad();
      $.if($.eq($.l(EOF), $.i(-1)), () => $.put(EOF, $.add($.eq($.l(CC), $.i(61)), $.eq($.l(DD), $.i(61)))));
      $.if($.eq($.l(EOF), $.i(2)), () => out($.shrU($.l(L), $.i(16))));
      $.if($.eq($.l(EOF), $.i(1)), () => {
        out($.shrU($.l(L), $.i(16)));
        out($.shrU($.l(L), $.i(8)));
      });
      $.if($.eq($.l(EOF), $.i(0)), () => {
        out($.shrU($.l(L), $.i(16)));
        out($.shrU($.l(L), $.i(8)));
        out($.l(L));
      });
      $.do($.add($.l(RET), $.sub($.i(3), $.l(EOF))));
    });
  }

  /* ── DER ───────────────────────────────────────────────────────────── */

  /** `(buf, pos, end) -> i64-ish packed: header length * 2^24 + content
   * length`, or -1 when the TLV at pos is malformed (over 3 length
   * bytes, or running past end), -2 when its length is indefinite; a
   * non-minimal long form sets the nc global. The tag is buf[pos]; a tag
   * number >= 31 (multi-byte) is malformed here too. */
  tlvFn(): number {
    return this.fn("tlv", [this.bRef, I32, I32], [I32, I32], (f, $) => {
      const [BUF, P, END] = [0, 1, 2];
      const L0 = f.local(I32);
      const N = f.local(I32);
      const LEN = f.local(I32);
      const I = f.local(I32);
      const bad = (): void => {
        $.do($.i(-1), $.i(-1));
        f.c.return_();
      };
      $.if($.ge($.add($.l(P), $.i(2)), $.add($.l(END), $.i(1))), () => bad());
      $.if($.eq($.and(this.byte($, $.l(BUF), $.l(P)), $.i(31)), $.i(31)), () => bad());
      $.put(L0, this.byte($, $.l(BUF), $.add($.l(P), $.i(1))));
      $.if($.lt($.l(L0), $.i(128)), () => {
        $.if($.gt($.add($.add($.l(P), $.i(2)), $.l(L0)), $.l(END)), () => bad());
        $.do($.i(2), $.l(L0));
        f.c.return_();
      });
      $.put(N, $.and($.l(L0), $.i(127)));
      // indefinite length: (-2, -2)
      $.if($.eq($.l(N), $.i(0)), () => {
        $.do($.i(-2), $.i(-2));
        f.c.return_();
      });
      $.if($.gt($.l(N), $.i(3)), () => bad());
      $.if($.gt($.add($.add($.l(P), $.i(2)), $.l(N)), $.l(END)), () => bad());
      $.for(I, $.i(0), $.l(N), () => $.put(LEN, $.or($.shl($.l(LEN), $.i(8)), this.byte($, $.l(BUF), $.add($.add($.l(P), $.i(2)), $.l(I))))));
      // not DER-minimal: a leading zero length byte, or a long form for < 128
      $.if($.either($.not(this.byte($, $.l(BUF), $.add($.l(P), $.i(2)))), $.lt($.l(LEN), $.i(128))), () => $.gput(this.g().nc, $.i(1)));
      $.if($.gt($.add($.add($.add($.l(P), $.i(2)), $.l(N)), $.l(LEN)), $.l(END)), () => bad());
      $.do($.add($.i(2), $.l(N)), $.l(LEN));
    });
  }

  /** The bytes value at [off, off + len) of a buffer, copied. */
  private sliceFn(): number {
    return this.fn("slice", [this.bRef, I32, I32], [this.ref(this.BT)], (f, $) => {
      const [BUF, OFF, LEN] = [0, 1, 2];
      const R = f.local(this.bRef);
      $.put(R, $.anew(this.B, $.l(LEN)));
      $.do($.l(R), $.i(0), $.l(BUF), $.l(OFF), $.l(LEN));
      f.c.arrayCopy(this.B, this.B);
      $.do($.new_(this.BT, $.raw((c) => {
        c.localGet(R);
        c.refAsNonNull();
      }), $.i(0), $.l(LEN)));
    });
  }

  /** `(decoded) -> bytes | null`: d2i_X509's reading at the outer
   * structure — Certificate ::= SEQUENCE { tbsCertificate, signature-
   * Algorithm, signature BIT STRING }, the TBS's fields by tag (version?,
   * serial, signature, issuer, validity, subject, subjectPublicKeyInfo,
   * the optional [1] [2] [3]). The answer is what i2d_X509 writes back:
   * the TBS as read (OpenSSL keeps its encoding), the outer header
   * re-encoded when it is not minimal or is indefinite (trailing bytes are
   * not read, as d2i). A non-minimal or indefinite length OpenSSL would
   * re-encode elsewhere sets err to PEM_NONCANON (a named fence). */
  certTlvFn(): number {
    return this.fn("certTlv", [this.ref(this.BT)], [this.ref(this.BT)], (f, $) => {
      const D = 0;
      const BUF = f.local(this.bRef);
      const OFF = f.local(I32);
      const END = f.local(I32);
      const HL = f.local(I32);
      const CL = f.local(I32);
      const P = f.local(I32);
      const CS = f.local(I32); // the outer content's start
      const CEND = f.local(I32);
      const TEND = f.local(I32);
      const Q = f.local(I32);
      const E = f.local(I32);
      const IND = f.local(I32);
      const REENC = f.local(I32);
      const T = f.local(I32);
      const R = f.local(this.bRef);
      const LN = f.local(I32);
      const g = this.g();
      const fail = (): void => $.ret($.nul(this.BT));
      const tlv = (p: X, end: X): void => {
        $.do($.call(this.tlvFn(), $.l(BUF), p, end));
        f.c.localSet(CL);
        f.c.localSet(HL);
        $.if($.eq($.l(HL), $.i(-2)), () => {
          $.gput(g.err, $.i(PEM_NONCANON));
          fail();
        });
        $.if($.lt($.l(HL), $.i(0)), () => fail());
      };
      const tagAt = (p: X): X => $.sel(I32, $.lt(p, $.l(END)), this.byte($, $.l(BUF), p), $.i(-1));
      const tagIs = (p: X, t: number): void => {
        $.if($.ne(tagAt(p), $.i(t)), () => fail());
      };
      /** an AlgorithmIdentifier at Q (a SEQUENCE starting with an OID)
       * within [.., e): Q moves past it */
      const algId = (e: X): void => {
        tagIs($.l(Q), 0x30);
        tlv($.l(Q), e);
        $.if($.not($.l(CL)), () => fail());
        tagIs($.add($.l(Q), $.l(HL)), 0x06);
        $.put(Q, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      };
      /** the element at Q (tag t) within [.., e): Q moves past it */
      const elem = (t: number, e: X): void => {
        tagIs($.l(Q), t);
        tlv($.l(Q), e);
        $.put(Q, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      };
      $.put(BUF, $.get(this.BT, 0, $.l(D)));
      $.put(OFF, $.get(this.BT, 1, $.l(D)));
      $.put(END, $.add($.l(OFF), $.get(this.BT, 2, $.l(D))));
      tagIs($.l(OFF), 0x30);
      $.if($.ge($.add($.l(OFF), $.i(1)), $.l(END)), () => fail());
      $.gput(g.nc, $.i(0));
      $.if($.eq(this.byte($, $.l(BUF), $.add($.l(OFF), $.i(1))), $.i(0x80)), () => {
        // an indefinite outer length: the content runs to an end-of-contents
        $.put(IND, $.i(1));
        $.put(CS, $.add($.l(OFF), $.i(2)));
        $.put(CEND, $.l(END));
      }, () => {
        tlv($.l(OFF), $.l(END));
        $.put(CS, $.add($.l(OFF), $.l(HL)));
        $.put(CEND, $.add($.l(CS), $.l(CL)));
      });
      $.put(REENC, $.either($.l(IND), $.g(g.nc)));
      // tbsCertificate (its own encoding is kept, so its lengths may be BER)
      $.put(P, $.l(CS));
      tagIs($.l(P), 0x30);
      tlv($.l(P), $.l(CEND));
      $.put(TEND, $.add($.add($.l(P), $.l(HL)), $.l(CL)));
      $.put(Q, $.add($.l(P), $.l(HL)));
      // the TBS's elements, each well-formed
      $.put(E, $.l(Q));
      $.while($.lt($.l(E), $.l(TEND)), () => {
        tlv($.l(E), $.l(TEND));
        $.put(E, $.add($.add($.l(E), $.l(HL)), $.l(CL)));
      });
      $.if($.eq(tagAt($.l(Q)), $.i(0xa0)), () => elem(0xa0, $.l(TEND)));
      elem(0x02, $.l(TEND)); // serialNumber
      algId($.l(TEND)); // signature AlgorithmIdentifier
      elem(0x30, $.l(TEND)); // issuer
      // validity: two times
      tagIs($.l(Q), 0x30);
      tlv($.l(Q), $.l(TEND));
      $.put(E, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      $.put(Q, $.add($.l(Q), $.l(HL)));
      for (let k = 0; k < 2; k++) {
        $.put(T, tagAt($.l(Q)));
        $.if($.both($.ne($.l(T), $.i(0x17)), $.ne($.l(T), $.i(0x18))), () => fail());
        tlv($.l(Q), $.l(E));
        $.put(Q, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      }
      $.if($.ne($.l(Q), $.l(E)), () => fail());
      elem(0x30, $.l(TEND)); // subject
      // subjectPublicKeyInfo: an AlgorithmIdentifier, a BIT STRING
      tagIs($.l(Q), 0x30);
      tlv($.l(Q), $.l(TEND));
      $.put(E, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      $.put(Q, $.add($.l(Q), $.l(HL)));
      elem(0x30, $.l(E));
      elem(0x03, $.l(E));
      $.if($.ne($.l(Q), $.l(E)), () => fail());
      $.if($.eq(tagAt($.l(Q)), $.i(0x81)), () => elem(0x81, $.l(TEND)));
      $.if($.eq(tagAt($.l(Q)), $.i(0x82)), () => elem(0x82, $.l(TEND)));
      $.if($.eq(tagAt($.l(Q)), $.i(0xa3)), () => elem(0xa3, $.l(TEND)));
      $.if($.ne($.l(Q), $.l(TEND)), () => fail());
      // signatureAlgorithm and signature: OpenSSL writes these back from
      // their values, so every length in them must already be minimal
      $.put(P, $.l(TEND));
      $.gput(g.nc, $.i(0));
      $.put(Q, $.l(P));
      algId($.l(CEND));
      tagIs($.l(Q), 0x03);
      tlv($.l(Q), $.l(CEND));
      $.if($.not($.l(CL)), () => fail());
      $.put(Q, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
      // every TLV inside the algorithm identifier, constructed ones entered
      $.put(E, $.l(P));
      $.while($.lt($.l(E), $.l(Q)), () => {
        $.put(T, this.byte($, $.l(BUF), $.l(E)));
        tlv($.l(E), $.l(Q));
        $.put(E, $.add($.l(E), $.sel(I32, $.and($.l(T), $.i(0x20)), $.l(HL), $.add($.l(HL), $.l(CL)))));
      });
      $.if($.g(g.nc), () => {
        $.gput(g.err, $.i(PEM_NONCANON));
        fail();
      });
      $.put(P, $.l(Q));
      $.if($.l(IND), () => {
        // the end-of-contents octets
        $.if($.gt($.add($.l(P), $.i(2)), $.l(END)), () => fail());
        $.if($.either(this.byte($, $.l(BUF), $.l(P)), this.byte($, $.l(BUF), $.add($.l(P), $.i(1)))), () => fail());
      }, () => {
        $.if($.ne($.l(P), $.l(CEND)), () => fail());
      });
      $.if($.not($.l(REENC)), () => $.ret($.call(this.sliceFn(), $.l(BUF), $.l(OFF), $.sub($.l(CEND), $.l(OFF)))));
      // i2d's outer header: 0x30 and the minimal length of [CS, P)
      $.put(CL, $.sub($.l(P), $.l(CS)));
      $.put(LN, $.sel(I32, $.lt($.l(CL), $.i(128)), $.i(0), $.sel(I32, $.lt($.l(CL), $.i(256)), $.i(1), $.sel(I32, $.lt($.l(CL), $.i(65536)), $.i(2), $.i(3)))));
      $.put(HL, $.add($.i(2), $.l(LN)));
      $.put(R, $.anew(this.B, $.add($.l(HL), $.l(CL))));
      $.aset(this.B, $.l(R), $.i(0), $.i(0x30));
      $.if($.not($.l(LN)), () => $.aset(this.B, $.l(R), $.i(1), $.l(CL)), () => {
        $.aset(this.B, $.l(R), $.i(1), $.or($.i(0x80), $.l(LN)));
        $.for(E, $.i(0), $.l(LN), () => $.aset(this.B, $.l(R), $.add($.i(2), $.l(E)), $.shrU($.l(CL), $.shl($.sub($.sub($.l(LN), $.i(1)), $.l(E)), $.i(3)))));
      });
      $.do($.l(R), $.l(HL), $.l(BUF), $.l(CS), $.l(CL));
      f.c.arrayCopy(this.B, this.B);
      $.do($.new_(this.BT, $.raw((c) => {
        c.localGet(R);
        c.refAsNonNull();
      }), $.i(0), $.add($.l(HL), $.l(CL))));
    });
  }

  /* ── the fields checkServerIdentity reads ─────────────────────────── */

  /** `(der) -> $info` — the leaf's subject CN values and its
   * subjectAltName (the first such extension). A construct this tier
   * does not print sets XI_BAD: 1 an alt name Node would quote (unsafe
   * characters), 2 an alt name of another kind (othername, DirName,
   * Registered ID, X400, EdiPartyName), 3 a CN string of a kind this
   * tier does not decode, 4 malformed DER, 5 an IP alt name of an odd
   * length. */
  x509InfoFn(): number {
    const IT = this.infoT();
    return this.fn("x509Info", [this.ref(this.BT)], [this.ref(IT)], (f, $) => {
      const D = 0;
      const R = f.local(this.ref(IT));
      const BUF = f.local(this.bRef);
      const OFF = f.local(I32);
      const END = f.local(I32);
      const HL = f.local(I32);
      const CL = f.local(I32);
      const P = f.local(I32);
      const TEND = f.local(I32);
      const IDX = f.local(I32);
      const Q = f.local(I32);
      const QEND = f.local(I32);
      const S = f.local(I32);
      const SEND = f.local(I32);
      const A_ = f.local(I32);
      const AEND = f.local(I32);
      const OIDP = f.local(I32);
      const OIDL = f.local(I32);
      const TAG = f.local(I32);
      const STR = f.local(this.sRef);
      const SAN = f.local(this.sRef);
      const I = f.local(I32);
      const bad = (code: number): void => {
        $.set(IT, XI_BAD, $.l(R), $.i(code));
        $.ret($.l(R));
      };
      $.put(R, $.raw((c) => c.structNewDefault(IT)));
      $.put(BUF, $.get(this.BT, 0, $.l(D)));
      $.put(OFF, $.get(this.BT, 1, $.l(D)));
      $.put(END, $.add($.l(OFF), $.get(this.BT, 2, $.l(D))));
      const tlv = (p: X, end: X): void => {
        $.do($.call(this.tlvFn(), $.l(BUF), p, end));
        f.c.localSet(CL);
        f.c.localSet(HL);
        $.if($.lt($.l(HL), $.i(0)), () => bad(4));
      };
      const tag = (p: X): X => this.byte($, $.l(BUF), p);
      // Certificate SEQUENCE -> tbs SEQUENCE
      tlv($.l(OFF), $.l(END));
      $.put(P, $.add($.l(OFF), $.l(HL)));
      tlv($.l(P), $.l(END));
      $.put(TEND, $.add($.add($.l(P), $.l(HL)), $.l(CL)));
      $.put(P, $.add($.l(P), $.l(HL)));
      // the version [0] is optional
      $.if($.eq(tag($.l(P)), $.i(0xa0)), () => {
        tlv($.l(P), $.l(TEND));
        $.put(P, $.add($.add($.l(P), $.l(HL)), $.l(CL)));
      });
      // serial, signature, issuer, validity, then the subject (index 4)
      const NEXTP = f.local(I32);
      $.while($.lt($.l(P), $.l(TEND)), () => {
        tlv($.l(P), $.l(TEND));
        $.put(NEXTP, $.add($.add($.l(P), $.l(HL)), $.l(CL)));
        $.if($.eq($.l(IDX), $.i(4)), () => {
          // Name: SEQUENCE OF SET OF SEQUENCE { OID, value }
          $.put(S, $.add($.l(P), $.l(HL)));
          $.put(SEND, $.add($.l(S), $.l(CL)));
          $.while($.lt($.l(S), $.l(SEND)), () => {
            tlv($.l(S), $.l(SEND));
            $.put(A_, $.add($.l(S), $.l(HL)));
            $.put(AEND, $.add($.l(A_), $.l(CL)));
            $.put(S, $.l(AEND));
            $.while($.lt($.l(A_), $.l(AEND)), () => {
              tlv($.l(A_), $.l(AEND));
              $.put(Q, $.add($.l(A_), $.l(HL)));
              $.put(QEND, $.add($.l(Q), $.l(CL)));
              $.put(A_, $.l(QEND));
              // the OID
              tlv($.l(Q), $.l(QEND));
              $.put(OIDP, $.add($.l(Q), $.l(HL)));
              $.put(OIDL, $.l(CL));
              $.put(Q, $.add($.l(OIDP), $.l(OIDL)));
              // 2.5.4.3 commonName = 55 04 03
              $.if($.andThen($.eq($.l(OIDL), $.i(3)), $.andThen($.eq(tag($.l(OIDP)), $.i(0x55)), $.andThen($.eq(tag($.add($.l(OIDP), $.i(1))), $.i(4)), $.eq(tag($.add($.l(OIDP), $.i(2))), $.i(3))))), () => {
                tlv($.l(Q), $.l(QEND));
                $.put(TAG, tag($.l(Q)));
                $.put(STR, $.call(this.asn1StrFn(), $.l(BUF), $.l(TAG), $.add($.l(Q), $.l(HL)), $.l(CL)));
                $.if($.isNull($.l(STR)), () => bad(3));
                $.set(IT, XI_CN, $.l(R), $.call(this.saPushFn(), $.get(IT, XI_CN, $.l(R)), $.get(IT, XI_CN_N, $.l(R)), $.l(STR)));
                $.set(IT, XI_CN_N, $.l(R), $.add($.get(IT, XI_CN_N, $.l(R)), $.i(1)));
              });
            });
          });
        });
        // extensions [3]
        $.if($.both($.gt($.l(IDX), $.i(5)), $.eq(tag($.l(P)), $.i(0xa3))), () => {
          $.put(S, $.add($.l(P), $.l(HL)));
          tlv($.l(S), $.add($.add($.l(P), $.l(HL)), $.l(CL)));
          $.put(SEND, $.add($.add($.l(S), $.l(HL)), $.l(CL)));
          $.put(S, $.add($.l(S), $.l(HL)));
          $.while($.lt($.l(S), $.l(SEND)), () => {
            tlv($.l(S), $.l(SEND));
            $.put(A_, $.add($.l(S), $.l(HL)));
            $.put(AEND, $.add($.l(A_), $.l(CL)));
            $.put(S, $.l(AEND));
            tlv($.l(A_), $.l(AEND));
            $.put(OIDP, $.add($.l(A_), $.l(HL)));
            $.put(OIDL, $.l(CL));
            $.put(A_, $.add($.l(OIDP), $.l(OIDL)));
            // 2.5.29.17 subjectAltName = 55 1D 11, the first one only
            $.if($.andThen($.isNull($.get(IT, XI_SAN, $.l(R))), $.andThen($.eq($.l(OIDL), $.i(3)), $.andThen($.eq(tag($.l(OIDP)), $.i(0x55)), $.andThen($.eq(tag($.add($.l(OIDP), $.i(1))), $.i(0x1d)), $.eq(tag($.add($.l(OIDP), $.i(2))), $.i(0x11)))))), () => {
              // critical BOOLEAN DEFAULT FALSE
              $.if($.eq(tag($.l(A_)), $.i(0x01)), () => {
                tlv($.l(A_), $.l(AEND));
                $.put(A_, $.add($.add($.l(A_), $.l(HL)), $.l(CL)));
              });
              // extnValue OCTET STRING { GeneralNames SEQUENCE }
              tlv($.l(A_), $.l(AEND));
              $.put(Q, $.add($.l(A_), $.l(HL)));
              tlv($.l(Q), $.add($.add($.l(A_), $.l(HL)), $.l(CL)));
              $.put(QEND, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
              $.put(Q, $.add($.l(Q), $.l(HL)));
              $.put(SAN, $.anew(this.S, $.i(0)));
              $.put(I, $.i(0));
              $.while($.lt($.l(Q), $.l(QEND)), () => {
                tlv($.l(Q), $.l(QEND));
                $.put(TAG, tag($.l(Q)));
                $.if($.l(I), () => $.put(SAN, this.cat($, $.l(SAN), this.lit($, ", "))));
                $.put(I, $.add($.l(I), $.i(1)));
                const body = $.add($.l(Q), $.l(HL));
                // dNSName [2], rfc822Name [1], URI [6]: IA5String
                for (const [t, prefix] of [[0x82, "DNS:"], [0x81, "email:"], [0x86, "URI:"]] as const) {
                  $.if($.eq($.l(TAG), $.i(t)), () => {
                    $.put(STR, $.call(this.safeAltFn(), $.l(BUF), body, $.l(CL)));
                    $.if($.isNull($.l(STR)), () => bad(1));
                    $.put(SAN, this.cat($, $.l(SAN), this.lit($, prefix), $.l(STR)));
                    if (t === 0x82) {
                      $.set(IT, XI_DNS, $.l(R), $.call(this.saPushFn(), $.get(IT, XI_DNS, $.l(R)), $.get(IT, XI_DNS_N, $.l(R)), $.l(STR)));
                      $.set(IT, XI_DNS_N, $.l(R), $.add($.get(IT, XI_DNS_N, $.l(R)), $.i(1)));
                    }
                  });
                }
                // iPAddress [7]
                $.if($.eq($.l(TAG), $.i(0x87)), () => {
                  $.if($.eq($.l(CL), $.i(4)), () => {
                    $.put(STR, $.call(this.ntop4Fn(), $.l(BUF), body));
                    $.put(SAN, this.cat($, $.l(SAN), this.lit($, "IP Address:"), $.l(STR)));
                  }, () => {
                    $.if($.eq($.l(CL), $.i(16)), () => {
                      $.put(SAN, this.cat($, $.l(SAN), this.lit($, "IP Address:"), $.call(this.groupsFn(), $.l(BUF), body)));
                      $.put(STR, $.call(this.ntop6Fn(), $.l(BUF), body));
                    }, () => bad(5));
                  });
                  $.set(IT, XI_IPS, $.l(R), $.call(this.saPushFn(), $.get(IT, XI_IPS, $.l(R)), $.get(IT, XI_IPS_N, $.l(R)), $.l(STR)));
                  $.set(IT, XI_IPS_N, $.l(R), $.add($.get(IT, XI_IPS_N, $.l(R)), $.i(1)));
                });
                $.if($.not($.or($.or($.eq($.l(TAG), $.i(0x82)), $.eq($.l(TAG), $.i(0x81))), $.or($.eq($.l(TAG), $.i(0x86)), $.eq($.l(TAG), $.i(0x87))))), () => bad(2));
                $.put(Q, $.add($.add($.l(Q), $.l(HL)), $.l(CL)));
              });
              $.set(IT, XI_SAN, $.l(R), $.l(SAN));
            });
          });
        });
        $.put(P, $.l(NEXTP));
        $.put(IDX, $.add($.l(IDX), $.i(1)));
      });
      $.do($.l(R));
    });
  }

  /** An IA5 alt name as PrintAltName writes it, or null when Node would
   * quote it (a byte outside ' '..'~', or one of " \ , '). */
  private safeAltFn(): number {
    return this.fn("safeAlt", [this.bRef, I32, I32], [this.sRef], (f, $) => {
      const [BUF, P, N] = [0, 1, 2];
      const I = f.local(I32);
      const CH = f.local(I32);
      const R = f.local(this.sRef);
      $.put(R, $.anew(this.S, $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(CH, this.byte($, $.l(BUF), $.add($.l(P), $.l(I))));
        $.if($.either($.either($.lt($.l(CH), $.i(32)), $.gt($.l(CH), $.i(126))), $.either($.either($.eq($.l(CH), $.i(34)), $.eq($.l(CH), $.i(92))), $.either($.eq($.l(CH), $.i(44)), $.eq($.l(CH), $.i(39))))), () => $.ret($.nul(this.S)));
        $.aset(this.S, $.l(R), $.l(I), $.l(CH));
      });
      $.do($.l(R));
    });
  }

  /** A DirectoryString as ASN1_STRING_to_UTF8 decodes it, or null. */
  private asn1StrFn(): number {
    return this.fn("asn1Str", [this.bRef, I32, I32, I32], [this.sRef], (f, $) => {
      const [BUF, TAG, P, N] = [0, 1, 2, 3];
      const I = f.local(I32);
      const R = f.local(this.sRef);
      const B2 = f.local(this.bRef);
      // UTF8String
      $.if($.eq($.l(TAG), $.i(0x0c)), () => {
        $.put(B2, $.anew(this.B, $.l(N)));
        $.do($.l(B2), $.i(0), $.l(BUF), $.l(P), $.l(N));
        f.c.arrayCopy(this.B, this.B);
        $.ret($.call(this.deps.utf8Decode(), $.new_(this.BT, $.raw((c) => {
          c.localGet(B2);
          c.refAsNonNull();
        }), $.i(0), $.l(N))));
      });
      // PrintableString, IA5String, T61String: one byte per character
      $.if($.or($.or($.eq($.l(TAG), $.i(0x13)), $.eq($.l(TAG), $.i(0x16))), $.eq($.l(TAG), $.i(0x14))), () => {
        $.put(R, $.anew(this.S, $.l(N)));
        $.for(I, $.i(0), $.l(N), () => $.aset(this.S, $.l(R), $.l(I), this.byte($, $.l(BUF), $.add($.l(P), $.l(I)))));
        $.ret($.l(R));
      });
      // BMPString: UCS-2 big-endian
      $.if($.both($.eq($.l(TAG), $.i(0x1e)), $.eq($.and($.l(N), $.i(1)), $.i(0))), () => {
        $.put(R, $.anew(this.S, $.shrU($.l(N), $.i(1))));
        $.for(I, $.i(0), $.shrU($.l(N), $.i(1)), () => {
          $.aset(this.S, $.l(R), $.l(I), $.or($.shl(this.byte($, $.l(BUF), $.add($.l(P), $.shl($.l(I), $.i(1)))), $.i(8)), this.byte($, $.l(BUF), $.add($.add($.l(P), $.shl($.l(I), $.i(1))), $.i(1)))));
        });
        $.ret($.l(R));
      });
      $.do($.nul(this.S));
    });
  }

  /** "a.b.c.d" for four bytes at p. */
  private ntop4Fn(): number {
    return this.fn("ntop4", [this.bRef, I32], [this.sRef], (f, $) => {
      const [BUF, P] = [0, 1];
      const d = (k: number): X => $.call(this.decFn(), this.byte($, $.l(BUF), $.add($.l(P), $.i(k))));
      $.do(this.cat($, d(0), this.lit($, "."), d(1), this.lit($, "."), d(2), this.lit($, "."), d(3)));
    });
  }

  /** PrintGeneralName's IPv6: eight %X groups joined by ':'. */
  private groupsFn(): number {
    return this.fn("groups", [this.bRef, I32], [this.sRef], (f, $) => {
      const [BUF, P] = [0, 1];
      const R = f.local(this.sRef);
      const J = f.local(I32);
      $.put(R, $.anew(this.S, $.i(0)));
      $.for(J, $.i(0), $.i(8), () => {
        $.if($.l(J), () => $.put(R, this.cat($, $.l(R), this.lit($, ":"))));
        $.put(R, this.cat($, $.l(R), $.call(this.hexFn(true), $.or($.shl(this.byte($, $.l(BUF), $.add($.l(P), $.shl($.l(J), $.i(1)))), $.i(8)), this.byte($, $.l(BUF), $.add($.add($.l(P), $.shl($.l(J), $.i(1))), $.i(1)))))));
      });
      $.do($.l(R));
    });
  }

  /** libuv's inet_ntop6 over 16 bytes at p (canonicalizeIP's answer). */
  ntop6Fn(): number {
    return this.fn("ntop6", [this.bRef, I32], [this.sRef], (f, $) => {
      const [BUF, P] = [0, 1];
      const W = f.local(this.ref(this.I32A));
      const I = f.local(I32);
      const BB = f.local(I32);
      const BL = f.local(I32);
      const CB_ = f.local(I32);
      const CL = f.local(I32);
      const R = f.local(this.sRef);
      $.put(W, $.anew(this.I32A, $.i(8)));
      $.for(I, $.i(0), $.i(8), () => {
        $.aset(this.I32A, $.l(W), $.l(I), $.or($.shl(this.byte($, $.l(BUF), $.add($.l(P), $.shl($.l(I), $.i(1)))), $.i(8)), this.byte($, $.l(BUF), $.add($.add($.l(P), $.shl($.l(I), $.i(1))), $.i(1)))));
      });
      // the longest run of zero words (the first of equals), length >= 2
      $.put(BB, $.i(-1));
      $.put(CB_, $.i(-1));
      $.for(I, $.i(0), $.i(8), () => {
        $.if($.eq($.aget(this.I32A, $.l(W), $.l(I)), $.i(0)), () => {
          $.if($.eq($.l(CB_), $.i(-1)), () => {
            $.put(CB_, $.l(I));
            $.put(CL, $.i(1));
          }, () => $.put(CL, $.add($.l(CL), $.i(1))));
        }, () => {
          $.if($.ne($.l(CB_), $.i(-1)), () => {
            $.if($.either($.eq($.l(BB), $.i(-1)), $.gt($.l(CL), $.l(BL))), () => {
              $.put(BB, $.l(CB_));
              $.put(BL, $.l(CL));
            });
            $.put(CB_, $.i(-1));
          });
        });
      });
      $.if($.ne($.l(CB_), $.i(-1)), () => {
        $.if($.either($.eq($.l(BB), $.i(-1)), $.gt($.l(CL), $.l(BL))), () => {
          $.put(BB, $.l(CB_));
          $.put(BL, $.l(CL));
        });
      });
      $.if($.both($.ne($.l(BB), $.i(-1)), $.lt($.l(BL), $.i(2))), () => $.put(BB, $.i(-1)));
      $.put(R, $.anew(this.S, $.i(0)));
      $.for(I, $.i(0), $.i(8), () => {
        f.c.block();
        // inside the best run
        $.if($.both($.ne($.l(BB), $.i(-1)), $.both($.ge($.l(I), $.l(BB)), $.lt($.l(I), $.add($.l(BB), $.l(BL))))), () => {
          $.if($.eq($.l(I), $.l(BB)), () => $.put(R, this.cat($, $.l(R), this.lit($, ":"))));
          f.c.br(1);
        });
        $.if($.ne($.l(I), $.i(0)), () => $.put(R, this.cat($, $.l(R), this.lit($, ":"))));
        // an encapsulated IPv4 address
        $.if($.both($.eq($.l(I), $.i(6)), $.both($.eq($.l(BB), $.i(0)), $.either($.eq($.l(BL), $.i(6)), $.either($.both($.eq($.l(BL), $.i(7)), $.ne($.aget(this.I32A, $.l(W), $.i(7)), $.i(1))), $.both($.eq($.l(BL), $.i(5)), $.eq($.aget(this.I32A, $.l(W), $.i(5)), $.i(0xffff))))))), () => {
          $.put(R, this.cat($, $.l(R), $.call(this.ntop4Fn(), $.l(BUF), $.add($.l(P), $.i(12)))));
          $.ret($.l(R));
        });
        $.put(R, this.cat($, $.l(R), $.call(this.hexFn(false), $.aget(this.I32A, $.l(W), $.l(I)))));
        f.c.end();
      });
      // a trailing run
      $.if($.both($.ne($.l(BB), $.i(-1)), $.eq($.add($.l(BB), $.l(BL)), $.i(8))), () => $.put(R, this.cat($, $.l(R), this.lit($, ":"))));
      $.do($.l(R));
    });
  }

  /** inet_pton6 over a string net.isIP already accepted as IPv6 (no zone
   * id): the 16 bytes, or null. */
  pton6Fn(): number {
    return this.fn("pton6", [this.sRef], [this.bRef], (f, $) => {
      const S = 0;
      const R = f.local(this.bRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const T = f.local(I32); // bytes written
      const COLONP = f.local(I32); // where '::' was, -1
      const CH = f.local(I32);
      const VAL = f.local(I32);
      const DIG = f.local(I32);
      const SEEN = f.local(I32);
      const START = f.local(I32);
      const DOTS = f.local(I32);
      const OCT = f.local(I32);
      const K = f.local(I32);
      const MOVE = f.local(I32);
      const at = (i: X): X => $.agetU(this.S, $.l(S), i);
      $.put(R, $.anew(this.B, $.i(16)));
      $.put(N, $.alen($.l(S)));
      $.put(COLONP, $.i(-1));
      $.if($.both($.gt($.l(N), $.i(1)), $.both($.eq(at($.i(0)), $.i(58)), $.eq(at($.i(1)), $.i(58)))), () => $.put(I, $.i(1)));
      $.put(START, $.l(I));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(CH, at($.l(I)));
        $.put(I, $.add($.l(I), $.i(1)));
        $.put(DIG, $.i(-1));
        $.if($.both($.ge($.l(CH), $.i(48)), $.le($.l(CH), $.i(57))), () => $.put(DIG, $.sub($.l(CH), $.i(48))));
        $.if($.both($.ge($.l(CH), $.i(97)), $.le($.l(CH), $.i(102))), () => $.put(DIG, $.sub($.l(CH), $.i(87))));
        $.if($.both($.ge($.l(CH), $.i(65)), $.le($.l(CH), $.i(70))), () => $.put(DIG, $.sub($.l(CH), $.i(55))));
        $.if($.ge($.l(DIG), $.i(0)), () => {
          $.put(VAL, $.or($.shl($.l(VAL), $.i(4)), $.l(DIG)));
          $.if($.gt($.l(VAL), $.i(0xffff)), () => $.ret($.nul(this.B)));
          $.put(SEEN, $.i(1));
        }, () => {
          $.if($.eq($.l(CH), $.i(58)), () => {
            $.put(START, $.l(I));
            $.if($.not($.l(SEEN)), () => {
              $.if($.ne($.l(COLONP), $.i(-1)), () => $.ret($.nul(this.B)));
              $.put(COLONP, $.l(T));
            }, () => {
              $.if($.gt($.add($.l(T), $.i(2)), $.i(16)), () => $.ret($.nul(this.B)));
              $.aset(this.B, $.l(R), $.l(T), $.shrU($.l(VAL), $.i(8)));
              $.aset(this.B, $.l(R), $.add($.l(T), $.i(1)), $.and($.l(VAL), $.i(255)));
              $.put(T, $.add($.l(T), $.i(2)));
              $.put(SEEN, $.i(0));
              $.put(VAL, $.i(0));
            });
          }, () => {
            // a dotted IPv4 tail from START
            $.if($.both($.eq($.l(CH), $.i(46)), $.le($.add($.l(T), $.i(4)), $.i(16))), () => {
              $.put(K, $.l(START));
              $.put(DOTS, $.i(0));
              $.put(OCT, $.i(0));
              $.while($.lt($.l(K), $.l(N)), () => {
                $.put(CH, at($.l(K)));
                $.if($.eq($.l(CH), $.i(46)), () => {
                  $.aset(this.B, $.l(R), $.add($.l(T), $.l(DOTS)), $.l(OCT));
                  $.put(DOTS, $.add($.l(DOTS), $.i(1)));
                  $.put(OCT, $.i(0));
                }, () => $.put(OCT, $.add($.mul($.l(OCT), $.i(10)), $.sub($.l(CH), $.i(48)))));
                $.put(K, $.add($.l(K), $.i(1)));
              });
              $.aset(this.B, $.l(R), $.add($.l(T), $.i(3)), $.l(OCT));
              $.put(T, $.add($.l(T), $.i(4)));
              $.put(SEEN, $.i(0));
              $.put(I, $.l(N));
            }, () => $.ret($.nul(this.B)));
          });
        });
      });
      $.if($.l(SEEN), () => {
        $.if($.gt($.add($.l(T), $.i(2)), $.i(16)), () => $.ret($.nul(this.B)));
        $.aset(this.B, $.l(R), $.l(T), $.shrU($.l(VAL), $.i(8)));
        $.aset(this.B, $.l(R), $.add($.l(T), $.i(1)), $.and($.l(VAL), $.i(255)));
        $.put(T, $.add($.l(T), $.i(2)));
      });
      $.if($.ne($.l(COLONP), $.i(-1)), () => {
        // shift the bytes after '::' to the end
        $.put(MOVE, $.sub($.l(T), $.l(COLONP)));
        $.if($.eq($.l(T), $.i(16)), () => $.ret($.nul(this.B)));
        $.for(K, $.i(1), $.add($.l(MOVE), $.i(1)), () => {
          $.aset(this.B, $.l(R), $.sub($.i(16), $.l(K)), $.agetU(this.B, $.l(R), $.sub($.add($.l(COLONP), $.l(MOVE)), $.l(K))));
          $.aset(this.B, $.l(R), $.sub($.add($.l(COLONP), $.l(MOVE)), $.l(K)), $.i(0));
        });
        $.put(T, $.i(16));
      });
      $.if($.ne($.l(T), $.i(16)), () => $.ret($.nul(this.B)));
      $.do($.l(R));
    });
  }
}
