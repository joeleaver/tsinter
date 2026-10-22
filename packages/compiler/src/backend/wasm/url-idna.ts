/* INC-29 U3 — domain to ASCII for the WHATWG URL host parser: Node
 * v24.18.1's vendored ada 3.4.4 idna (ada::idna::to_ascii and everything
 * it reaches — unicode_transcoding.cpp, mapping.cpp, normalization.cpp,
 * punycode.cpp, validity.cpp, to_ascii.cpp), transcribed function for
 * function over code-point buffers, with ada's own UTS #46 / NFC / bidi
 * tables as data (url-tables.ts). The tables are materialized into GC
 * arrays on the first non-ASCII or "xn--" host, never before.
 *
 * Every quirk of ada's code is kept, not the spec's: map() answers an
 * empty string on a disallowed code point, is_label_valid's ZWNJ/ZWJ
 * ContextJ checks return early, and its LTR loop stops before the last
 * non-NSM character — Node runs exactly this code. */
import { A, Fn, type X } from "./asm.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";
import {
  URL_CCC_BLOCK, URL_CCC_INDEX, URL_COMBINING, URL_COMP_BLOCK, URL_COMP_DATA, URL_COMP_INDEX,
  URL_DECOMP_BLOCK, URL_DECOMP_DATA, URL_DECOMP_INDEX, URL_DIR_DIR, URL_DIR_FINAL, URL_DIR_START,
  URL_IDNA_DESC, URL_IDNA_MAPPINGS, URL_IDNA_START, URL_JOIN_D, URL_JOIN_L, URL_JOIN_R, URL_VIRAMA, urlTableBytes,
} from "./url-tables.js";

/* validity.cpp's direction enum ordinals */
const D_BN = 1;
const D_CS = 2;
const D_ES = 3;
const D_ON = 4;
const D_EN = 5;
const D_L = 6;
const D_R = 7;
const D_NSM = 8;
const D_AL = 9;
const D_AN = 10;
const D_ET = 11;

const SBASE = 0xac00;
const TBASE = 0x11a7;
const VBASE = 0x1161;
const LBASE = 0x1100;
const LCOUNT = 19;
const VCOUNT = 21;
const TCOUNT = 28;
const NCOUNT = VCOUNT * TCOUNT;
const SCOUNT = LCOUNT * NCOUNT;

const CB_A = 0;
const CB_N = 1;

/** How a table is packed in url-tables.ts (see its header). */
type Pack = "u8" | "u24" | "u32" | "rowdelta";
const TABLES: Record<string, { b64: string; pack: Pack }> = {
  mapStart: { b64: URL_IDNA_START, pack: "u24" },
  mapDesc: { b64: URL_IDNA_DESC, pack: "u32" },
  mappings: { b64: URL_IDNA_MAPPINGS, pack: "u24" },
  decompIndex: { b64: URL_DECOMP_INDEX, pack: "u8" },
  decompBlock: { b64: URL_DECOMP_BLOCK, pack: "rowdelta" },
  decompData: { b64: URL_DECOMP_DATA, pack: "u24" },
  cccIndex: { b64: URL_CCC_INDEX, pack: "u8" },
  cccBlock: { b64: URL_CCC_BLOCK, pack: "u8" },
  compIndex: { b64: URL_COMP_INDEX, pack: "u8" },
  compBlock: { b64: URL_COMP_BLOCK, pack: "rowdelta" },
  compData: { b64: URL_COMP_DATA, pack: "u24" },
  dirStart: { b64: URL_DIR_START, pack: "u24" },
  dirFinal: { b64: URL_DIR_FINAL, pack: "u24" },
  dirDir: { b64: URL_DIR_DIR, pack: "u8" },
  combining: { b64: URL_COMBINING, pack: "u24" },
};

export class IdnaBuilder {
  private readonly fns = new Map<string, number>();
  private readonly globals = new Map<string, { g: number; off: number; bytes: number; len: number; type: number }>();
  private cbT_: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly bytesType: () => number,
  ) {}

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.idna.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }
  private get B8(): number {
    return this.bytesType();
  }
  private get bRef(): ValType {
    return this.ref(this.B8);
  }
  private get I32A(): number {
    return this.mb.arrayType(I32, true);
  }
  private get I16A(): number {
    return this.mb.arrayType("i16", true);
  }
  /** The unpacked array type: bytes stay bytes, rowdelta blocks are u16,
   * u24 / u32 are i32. */
  private arrType(p: Pack): number {
    return p === "u8" ? this.B8 : p === "rowdelta" ? this.I16A : this.I32A;
  }
  /** A code-point buffer. */
  private get CB(): number {
    this.cbT_ ??= this.mb.openStructType("idna:cpbuf", [
      { storage: this.ref(this.I32A), mutable: true },
      { storage: I32, mutable: true },
    ]);
    return this.cbT_;
  }
  private get cbRef(): ValType {
    return this.ref(this.CB);
  }

  /* ── tables ───────────────────────────────────────────────────────── */

  private tableGlobal(name: string): { g: number; off: number; bytes: number; len: number; type: number } {
    let t = this.globals.get(name);
    if (t === undefined) {
      const spec = TABLES[name]!;
      const bytes = urlTableBytes(spec.b64);
      const len = spec.pack === "u8" ? bytes.length : spec.pack === "u24" ? bytes.length / 3 : spec.pack === "u32" ? bytes.length / 4 : (bytes.length / 258) * 257;
      const type = this.arrType(spec.pack);
      const g = this.mb.addGlobal(this.ref(type), true, (w) => {
        w.u8(0xd0);
        w.sleb(type);
      });
      t = { g, off: this.mb.internData(bytes), bytes: bytes.length, len, type };
      this.globals.set(name, t);
    }
    return t;
  }
  /** Unpack every table (on the first non-ASCII or "xn--" host). */
  private initFn(): number {
    return this.fn("init", [], [], (f, $) => {
      const RAW = f.local(this.bRef);
      const I = f.local(I32);
      const first = this.tableGlobal("mapStart");
      const raw = (k: X): X => $.agetU(this.B8, $.l(RAW), k);
      $.if($.isNull($.g(first.g)), () => {
        for (const name of Object.keys(TABLES)) {
          const t = this.tableGlobal(name);
          const pack = TABLES[name]!.pack;
          if (pack === "u8" || pack === "u32") {
            $.c.i32Const(t.off);
            $.c.i32Const(t.len);
            $.c.arrayNewData(t.type, 0);
            $.c.globalSet(t.g);
            continue;
          }
          $.c.i32Const(t.off);
          $.c.i32Const(t.bytes);
          $.c.arrayNewData(this.B8, 0);
          $.c.localSet(RAW);
          $.gput(t.g, $.anew(t.type, $.i(t.len)));
          if (pack === "u24") {
            $.for(I, $.i(0), $.i(t.len), () => {
              const at = (k: number): X => raw($.add($.mul($.l(I), $.i(3)), $.i(k)));
              $.aset(t.type, $.g(t.g), $.l(I), $.or(at(0), $.or($.shl(at(1), $.i(8)), $.shl(at(2), $.i(16)))));
            });
          } else {
            // rowdelta: per 257-entry row, a u16 then 256 byte deltas
            $.for(I, $.i(0), $.i(t.len), () => {
              const row = (): X => this.div($, $.l(I), $.i(257));
              const col = (): X => this.rem($, $.l(I), $.i(257));
              const base = (): X => $.mul(row(), $.i(258));
              $.if($.not(col()), () => {
                $.aset(t.type, $.g(t.g), $.l(I), $.or(raw(base()), $.shl(raw($.add(base(), $.i(1))), $.i(8))));
              }, () => {
                $.aset(t.type, $.g(t.g), $.l(I), $.add($.agetU(t.type, $.g(t.g), $.sub($.l(I), $.i(1))), raw($.add(base(), $.add(col(), $.i(1))))));
              });
            });
          }
        }
      });
    });
  }
  private tget($: A, name: string, i: X): X {
    const t = this.tableGlobal(name);
    const pack = TABLES[name]!.pack;
    return pack === "u24" || pack === "u32" ? $.aget(t.type, $.g(t.g), i) : $.agetU(t.type, $.g(t.g), i);
  }

  /* ── code-point buffers ───────────────────────────────────────────── */

  private cbNew($: A, cap: X): X {
    return $.new_(this.CB, $.anew(this.I32A, cap), $.i(0));
  }
  private cbPushFn(): number {
    return this.fn("cbPush", [this.cbRef, I32], [], (f, $) => {
      const [O, V] = [0, 1];
      const N = f.local(I32);
      const NA = f.local(this.ref(this.I32A));
      $.put(N, $.get(this.CB, CB_N, $.l(O)));
      $.if($.ge($.l(N), $.alen($.get(this.CB, CB_A, $.l(O)))), () => {
        $.put(NA, $.anew(this.I32A, $.add($.mul($.l(N), $.i(2)), $.i(8))));
        $.do($.l(NA), $.i(0), $.get(this.CB, CB_A, $.l(O)), $.i(0), $.l(N));
        $.c.arrayCopy(this.I32A, this.I32A);
        $.set(this.CB, CB_A, $.l(O), $.l(NA));
      });
      $.aset(this.I32A, $.get(this.CB, CB_A, $.l(O)), $.l(N), $.l(V));
      $.set(this.CB, CB_N, $.l(O), $.add($.l(N), $.i(1)));
    });
  }
  private cpush($: A, cb: X, v: X): void {
    $.run(this.cbPushFn(), cb, v);
  }
  private cat($: A, cb: X, i: X): X {
    return $.aget(this.I32A, $.get(this.CB, CB_A, cb), i);
  }
  private cset($: A, cb: X, i: X, v: X): void {
    $.aset(this.I32A, $.get(this.CB, CB_A, cb), i, v);
  }
  private clen($: A, cb: X): X {
    return $.get(this.CB, CB_N, cb);
  }
  /** cb[from, to) as a fresh buffer */
  private cbSliceFn(): number {
    return this.fn("cbSlice", [this.cbRef, I32, I32], [this.cbRef], (f, $) => {
      const [S, F, T] = [0, 1, 2];
      const R = f.local(this.cbRef);
      const I = f.local(I32);
      $.put(R, this.cbNew($, $.add($.sub($.l(T), $.l(F)), $.i(1))));
      $.for(I, $.l(F), $.l(T), () => this.cpush($, $.l(R), this.cat($, $.l(S), $.l(I))));
      $.do($.l(R));
    });
  }
  private cbEqFn(): number {
    return this.fn("cbEq", [this.cbRef, this.cbRef], [I32], (f, $) => {
      const [A_, B_] = [0, 1];
      const I = f.local(I32);
      $.if($.ne(this.clen($, $.l(A_)), this.clen($, $.l(B_))), () => $.ret($.i(0)));
      $.for(I, $.i(0), this.clen($, $.l(A_)), () => $.if($.ne(this.cat($, $.l(A_), $.l(I)), this.cat($, $.l(B_), $.l(I))), () => $.ret($.i(0))));
      $.do($.i(1));
    });
  }
  private cbAsciiFn(): number {
    return this.fn("cbAscii", [this.cbRef], [I32], (f, $) => {
      const I = f.local(I32);
      $.for(I, $.i(0), this.clen($, $.l(0)), () => $.if($.geU(this.cat($, $.l(0), $.l(I)), $.i(0x80)), () => $.ret($.i(0))));
      $.do($.i(1));
    });
  }

  /** ob-like byte output: we reuse a code-point buffer of bytes, converted
   * to bytes at the end. */
  private cbToBytesFn(): number {
    return this.fn("cbToBytes", [this.cbRef], [this.bRef], (f, $) => {
      const R = f.local(this.bRef);
      const I = f.local(I32);
      $.put(R, $.anew(this.B8, this.clen($, $.l(0))));
      $.for(I, $.i(0), this.clen($, $.l(0)), () => $.aset(this.B8, $.l(R), $.l(I), this.cat($, $.l(0), $.l(I))));
      $.do($.l(R));
    });
  }

  /* ── unicode_transcoding.cpp ──────────────────────────────────────── */

  /** utf8_to_utf32: the code points, or null (invalid UTF-8). */
  private utf8ToUtf32Fn(): number {
    return this.fn("utf8ToUtf32", [this.bRef, I32, I32], [this.cbRef], (f, $) => {
      const [BY, F, T] = [0, 1, 2];
      const R = f.local(this.cbRef);
      const P = f.local(I32);
      const L = f.local(I32);
      const CP = f.local(I32);
      const at = (k: number): X => $.agetU(this.B8, $.l(BY), $.add($.l(P), $.i(k)));
      const cont = (k: number): X => $.eq($.and(at(k), $.i(0xc0)), $.i(0x80));
      const nul = (): void => $.ret($.nul(this.CB));
      $.put(R, this.cbNew($, $.add($.sub($.l(T), $.l(F)), $.i(1))));
      $.put(P, $.l(F));
      $.while($.lt($.l(P), $.l(T)), () => {
        $.put(L, at(0));
        $.if($.lt($.l(L), $.i(0x80)), () => {
          this.cpush($, $.l(R), $.l(L));
          $.put(P, $.add($.l(P), $.i(1)));
        }, () => $.if($.eq($.and($.l(L), $.i(0xe0)), $.i(0xc0)), () => {
          $.if($.ge($.add($.l(P), $.i(1)), $.l(T)), nul);
          $.if($.not(cont(1)), nul);
          $.put(CP, $.or($.shl($.and($.l(L), $.i(0x1f)), $.i(6)), $.and(at(1), $.i(0x3f))));
          $.if($.either($.lt($.l(CP), $.i(0x80)), $.gt($.l(CP), $.i(0x7ff))), nul);
          this.cpush($, $.l(R), $.l(CP));
          $.put(P, $.add($.l(P), $.i(2)));
        }, () => $.if($.eq($.and($.l(L), $.i(0xf0)), $.i(0xe0)), () => {
          $.if($.ge($.add($.l(P), $.i(2)), $.l(T)), nul);
          $.if($.not($.both(cont(1), cont(2))), nul);
          $.put(CP, $.or($.or($.shl($.and($.l(L), $.i(0xf)), $.i(12)), $.shl($.and(at(1), $.i(0x3f)), $.i(6))), $.and(at(2), $.i(0x3f))));
          $.if($.either($.either($.lt($.l(CP), $.i(0x800)), $.gt($.l(CP), $.i(0xffff))), $.both($.gt($.l(CP), $.i(0xd7ff)), $.lt($.l(CP), $.i(0xe000)))), nul);
          this.cpush($, $.l(R), $.l(CP));
          $.put(P, $.add($.l(P), $.i(3)));
        }, () => $.if($.eq($.and($.l(L), $.i(0xf8)), $.i(0xf0)), () => {
          $.if($.ge($.add($.l(P), $.i(3)), $.l(T)), nul);
          $.if($.not($.both(cont(1), $.both(cont(2), cont(3)))), nul);
          $.put(CP, $.or($.or($.shl($.and($.l(L), $.i(7)), $.i(18)), $.shl($.and(at(1), $.i(0x3f)), $.i(12))), $.or($.shl($.and(at(2), $.i(0x3f)), $.i(6)), $.and(at(3), $.i(0x3f)))));
          $.if($.either($.le($.l(CP), $.i(0xffff)), $.gt($.l(CP), $.i(0x10ffff))), nul);
          this.cpush($, $.l(R), $.l(CP));
          $.put(P, $.add($.l(P), $.i(4)));
        }, nul))));
      });
      $.if($.not(this.clen($, $.l(R))), nul);
      $.do($.l(R));
    });
  }

  /* ── mapping.cpp ──────────────────────────────────────────────────── */

  private findRangeFn(): number {
    return this.fn("findRange", [I32], [I32], (f, $) => {
      const KEY = 0;
      const LO = f.local(I32);
      const HI = f.local(I32);
      const MID = f.local(I32);
      const MV = f.local(I32);
      $.put(HI, $.i(this.tableGlobal("mapStart").len - 1));
      $.while($.le($.l(LO), $.l(HI)), () => {
        $.put(MID, $.shrU($.add($.l(LO), $.l(HI)), $.i(1)));
        $.put(MV, this.tget($, "mapStart", $.l(MID)));
        $.if($.ltU($.l(MV), $.l(KEY)), () => $.put(LO, $.add($.l(MID), $.i(1))), () => {
          $.if($.ltU($.l(KEY), $.l(MV)), () => $.put(HI, $.sub($.l(MID), $.i(1))), () => $.ret($.l(MID)));
        });
      });
      $.do($.sel(I32, $.not($.l(LO)), $.i(0), $.sub($.l(LO), $.i(1))));
    });
  }

  /** map(): the mapped code points, or null (a disallowed code point —
   * ada answers the empty string there). */
  private mapFn(): number {
    return this.fn("map", [this.cbRef], [this.cbRef], (f, $) => {
      const IN = 0;
      const R = f.local(this.cbRef);
      const I = f.local(I32);
      const X1 = f.local(I32);
      const D = f.local(I32);
      const K = f.local(I32);
      const C = f.local(I32);
      $.put(R, this.cbNew($, $.add(this.clen($, $.l(IN)), $.i(1))));
      $.for(I, $.i(0), this.clen($, $.l(IN)), () => {
        $.put(X1, this.cat($, $.l(IN), $.l(I)));
        $.put(D, this.tget($, "mapDesc", $.call(this.findRangeFn(), $.l(X1))));
        $.put(C, $.and($.l(D), $.i(0xff)));
        $.if($.eq($.l(C), $.i(1)), () => this.cpush($, $.l(R), $.l(X1)), () => {
          $.if($.eq($.l(C), $.i(2)), () => $.ret($.nul(this.CB)));
          $.if($.ne($.l(C), $.i(0)), () => {
            $.for(K, $.and($.shrU($.l(D), $.i(8)), $.i(0xffff)), $.add($.and($.shrU($.l(D), $.i(8)), $.i(0xffff)), $.shrU($.l(D), $.i(24))), () => {
              this.cpush($, $.l(R), this.tget($, "mappings", $.l(K)));
            });
          });
        });
      });
      $.do($.l(R));
    });
  }

  /* ── normalization.cpp ────────────────────────────────────────────── */

  private cccFn(): number {
    return this.fn("ccc", [I32], [I32], (_f, $) => {
      const C = 0;
      $.if($.geU($.l(C), $.i(0x110000)), () => $.ret($.i(0)));
      $.do(this.tget($, "cccBlock", $.add($.mul(this.tget($, "cccIndex", $.shrU($.l(C), $.i(8))), $.i(256)), $.and($.l(C), $.i(255)))));
    });
  }

  /** NFC: decompose, sort marks, compose — into a fresh buffer. */
  private normalizeFn(): number {
    return this.fn("normalize", [this.cbRef], [this.cbRef], (f, $) => {
      const IN = 0;
      const R = f.local(this.cbRef);
      const I = f.local(I32);
      const C = f.local(I32);
      const SI = f.local(I32);
      const DP = f.local(I32);
      const D0 = f.local(I32);
      const DL = f.local(I32);
      const K = f.local(I32);
      const CC = f.local(I32);
      const BI = f.local(I32);
      const GO = f.local(I32);
      const CUR = f.local(I32);
      // decompose (forward; ada writes backward into a resized buffer —
      // the same sequence)
      $.put(R, this.cbNew($, $.add(this.clen($, $.l(IN)), $.i(4))));
      $.for(I, $.i(0), this.clen($, $.l(IN)), () => {
        $.put(C, this.cat($, $.l(IN), $.l(I)));
        $.if($.both($.geU($.l(C), $.i(SBASE)), $.ltU($.l(C), $.i(SBASE + SCOUNT))), () => {
          $.put(SI, $.sub($.l(C), $.i(SBASE)));
          this.cpush($, $.l(R), $.add($.i(LBASE), this.div($, $.l(SI), $.i(NCOUNT))));
          this.cpush($, $.l(R), $.add($.i(VBASE), this.div($, this.rem($, $.l(SI), $.i(NCOUNT)), $.i(TCOUNT))));
          $.if(this.rem($, $.l(SI), $.i(TCOUNT)), () => this.cpush($, $.l(R), $.add($.i(TBASE), this.rem($, $.l(SI), $.i(TCOUNT)))));
        }, () => {
          $.if($.ltU($.l(C), $.i(0x110000)), () => {
            $.put(DP, $.add($.mul(this.tget($, "decompIndex", $.shrU($.l(C), $.i(8))), $.i(257)), $.and($.l(C), $.i(255))));
            $.put(D0, this.tget($, "decompBlock", $.l(DP)));
            $.put(DL, $.sub($.shrU(this.tget($, "decompBlock", $.add($.l(DP), $.i(1))), $.i(2)), $.shrU($.l(D0), $.i(2))));
            $.if($.both($.gt($.l(DL), $.i(0)), $.and($.l(D0), $.i(1))), () => $.put(DL, $.i(0)));
            $.if($.gt($.l(DL), $.i(0)), () => {
              $.for(K, $.i(0), $.l(DL), () => this.cpush($, $.l(R), this.tget($, "decompData", $.add($.shrU($.l(D0), $.i(2)), $.l(K)))));
            }, () => this.cpush($, $.l(R), $.l(C)));
          }, () => this.cpush($, $.l(R), $.l(C)));
        });
      });
      // sort_marks
      $.for(I, $.i(1), this.clen($, $.l(R)), () => {
        $.put(CC, $.call(this.cccFn(), this.cat($, $.l(R), $.l(I))));
        $.if($.l(CC), () => {
          $.put(CUR, this.cat($, $.l(R), $.l(I)));
          $.put(BI, $.l(I));
          $.put(GO, $.i(1));
          $.while($.both($.l(GO), $.ne($.l(BI), $.i(0))), () => {
            $.if($.gt($.call(this.cccFn(), this.cat($, $.l(R), $.sub($.l(BI), $.i(1)))), $.l(CC)), () => {
              this.cset($, $.l(R), $.l(BI), this.cat($, $.l(R), $.sub($.l(BI), $.i(1))));
              $.put(BI, $.sub($.l(BI), $.i(1)));
            }, () => $.put(GO, $.i(0)));
          });
          this.cset($, $.l(R), $.l(BI), $.l(CUR));
        });
      });
      $.run(this.composeFn(), $.l(R));
      $.do($.l(R));
    });
  }

  private div($: A, a: X, b: X): X {
    return () => {
      a();
      b();
      $.c.i32DivU();
    };
  }
  private rem($: A, a: X, b: X): X {
    return () => {
      a();
      b();
      $.c.i32RemU();
    };
  }

  /** compose(), in place */
  private composeFn(): number {
    return this.fn("compose", [this.cbRef], [], (f, $) => {
      const B = 0;
      const IC = f.local(I32);
      const CC = f.local(I32);
      const N = f.local(I32);
      const X1 = f.local(I32);
      const NX = f.local(I32);
      const CP = f.local(I32);
      const ICC = f.local(I32);
      const PREV = f.local(I32);
      const CCC = f.local(I32);
      const LEFT = f.local(I32);
      const RIGHT = f.local(I32);
      const MID = f.local(I32);
      const GO = f.local(I32);
      const FOUND = f.local(I32);
      const at = (i: X): X => this.cat($, $.l(B), i);
      const set = (i: X, v: X): void => this.cset($, $.l(B), i, v);
      const cdata = (i: X): X => this.tget($, "compData", i);
      const cblock = (i: X): X => this.tget($, "compBlock", i);
      const compPtr = (c: X): X => $.add($.mul(this.tget($, "compIndex", $.shrU(c, $.i(8))), $.i(257)), $.and(c, $.i(255)));
      const isT = (v: X): X => $.both($.gtU(v, $.i(TBASE)), $.ltU(v, $.i(TBASE + TCOUNT)));
      $.put(N, this.clen($, $.l(B)));
      $.while($.lt($.l(IC), $.l(N)), () => {
        $.put(X1, at($.l(IC)));
        set($.l(CC), $.l(X1));
        $.if($.both($.geU($.l(X1), $.i(LBASE)), $.ltU($.l(X1), $.i(LBASE + LCOUNT))), () => {
          $.if($.andThen($.lt($.add($.l(IC), $.i(1)), $.l(N)), $.both($.geU(at($.add($.l(IC), $.i(1))), $.i(VBASE)), $.ltU(at($.add($.l(IC), $.i(1))), $.i(VBASE + VCOUNT)))), () => {
            set($.l(CC), $.add($.i(SBASE), $.mul($.sub($.add($.mul($.sub($.l(X1), $.i(LBASE)), $.i(VCOUNT)), at($.add($.l(IC), $.i(1)))), $.i(VBASE)), $.i(TCOUNT))));
            $.put(IC, $.add($.l(IC), $.i(1)));
            $.if($.andThen($.lt($.add($.l(IC), $.i(1)), $.l(N)), isT(at($.add($.l(IC), $.i(1))))), () => {
              $.put(IC, $.add($.l(IC), $.i(1)));
              set($.l(CC), $.add(at($.l(CC)), $.sub(at($.l(IC)), $.i(TBASE))));
            });
          });
        }, () => $.if($.both($.geU($.l(X1), $.i(SBASE)), $.ltU($.l(X1), $.i(SBASE + SCOUNT))), () => {
          $.if($.andThen($.ne(this.rem($, $.sub($.l(X1), $.i(SBASE)), $.i(TCOUNT)), $.i(0)), $.andThen($.lt($.add($.l(IC), $.i(1)), $.l(N)), isT(at($.add($.l(IC), $.i(1)))))), () => {
            $.put(IC, $.add($.l(IC), $.i(1)));
            set($.l(CC), $.add(at($.l(CC)), $.sub(at($.l(IC)), $.i(TBASE))));
          });
        }, () => $.if($.ltU($.l(X1), $.i(0x110000)), () => {
          $.put(CP, compPtr($.l(X1)));
          $.put(ICC, $.l(CC));
          $.put(PREV, $.i(-1));
          $.put(GO, $.i(1));
          $.while($.both($.l(GO), $.lt($.add($.l(IC), $.i(1)), $.l(N))), () => {
            $.put(NX, at($.add($.l(IC), $.i(1))));
            $.put(CCC, $.call(this.cccFn(), $.l(NX)));
            $.put(FOUND, $.i(0));
            $.if($.both($.ne(cblock($.add($.l(CP), $.i(1))), cblock($.l(CP))), $.lt($.l(PREV), $.l(CCC))), () => {
              $.put(LEFT, cblock($.l(CP)));
              $.put(RIGHT, cblock($.add($.l(CP), $.i(1))));
              $.while($.lt($.add($.l(LEFT), $.i(2)), $.l(RIGHT)), () => {
                $.put(MID, $.add($.l(LEFT), $.and($.shrU($.sub($.l(RIGHT), $.l(LEFT)), $.i(1)), $.i(~1))));
                $.if($.leU(cdata($.l(MID)), $.l(NX)), () => $.put(LEFT, $.l(MID)));
                $.if($.geU(cdata($.l(MID)), $.l(NX)), () => $.put(RIGHT, $.l(MID)));
              });
              $.if($.eq(cdata($.l(LEFT)), $.l(NX)), () => {
                set($.l(ICC), cdata($.add($.l(LEFT), $.i(1))));
                $.put(CP, compPtr(cdata($.add($.l(LEFT), $.i(1)))));
                $.put(FOUND, $.i(1));
              });
            });
            $.if($.l(FOUND), () => $.put(IC, $.add($.l(IC), $.i(1))), () => {
              $.if($.not($.l(CCC)), () => $.put(GO, $.i(0)), () => {
                $.put(PREV, $.l(CCC));
                $.put(CC, $.add($.l(CC), $.i(1)));
                set($.l(CC), $.l(NX));
                $.put(IC, $.add($.l(IC), $.i(1)));
              });
            });
          });
        })));
        $.put(IC, $.add($.l(IC), $.i(1)));
        $.put(CC, $.add($.l(CC), $.i(1)));
      });
      $.if($.lt($.l(CC), $.l(IC)), () => $.set(this.CB, CB_N, $.l(B), $.l(CC)));
    });
  }

  /* ── punycode.cpp ─────────────────────────────────────────────────── */

  private adaptFn(): number {
    return this.fn("adapt", [I32, I32, I32], [I32], (f, $) => {
      const [D, N, FIRST] = [0, 1, 2];
      const K = f.local(I32);
      const sdiv = (a: X, b: X): X => () => {
        a();
        b();
        $.c.i32DivS();
      };
      $.put(D, $.sel(I32, $.l(FIRST), sdiv($.l(D), $.i(700)), sdiv($.l(D), $.i(2))));
      $.put(D, $.add($.l(D), sdiv($.l(D), $.l(N))));
      $.while($.gt($.l(D), $.i(455)), () => {
        $.put(D, sdiv($.l(D), $.i(35)));
        $.put(K, $.add($.l(K), $.i(36)));
      });
      $.do($.add($.l(K), sdiv($.mul($.i(36), $.l(D)), $.add($.l(D), $.i(38)))));
    });
  }

  /** punycode_to_utf32(bytes[from, to)): the code points, or null. */
  private punyDecodeFn(): number {
    return this.fn("punyDecode", [this.bRef, I32, I32], [this.cbRef], (f, $) => {
      const [BY, F0, T] = [0, 1, 2];
      const F = f.local(I32);
      const OUT = f.local(this.cbRef);
      const WO = f.local(I32);
      const N = f.local(I32);
      const I = f.local(I32);
      const BIAS = f.local(I32);
      const EA = f.local(I32);
      const K = f.local(I32);
      const OLDI = f.local(I32);
      const W = f.local(I32);
      const DG = f.local(I32);
      const TT = f.local(I32);
      const C = f.local(I32);
      const J = f.local(I32);
      const GO = f.local(I32);
      const at = (i: X): X => $.agetU(this.B8, $.l(BY), i);
      const nul = (): void => $.ret($.nul(this.CB));
      const sdiv = (a: X, b: X): X => () => {
        a();
        b();
        $.c.i32DivS();
      };
      const srem = (a: X, b: X): X => () => {
        a();
        b();
        $.c.i32RemS();
      };
      $.put(F, $.l(F0));
      // "xn--" again is an error (whatwg/url#803)
      $.if($.andThen($.ge($.sub($.l(T), $.l(F)), $.i(4)), $.both($.both($.eq(at($.l(F)), $.i(120)), $.eq(at($.add($.l(F), $.i(1))), $.i(110))), $.both($.eq(at($.add($.l(F), $.i(2))), $.i(45)), $.eq(at($.add($.l(F), $.i(3))), $.i(45))))), nul);
      $.put(OUT, this.cbNew($, $.add($.sub($.l(T), $.l(F)), $.i(1))));
      $.put(N, $.i(128));
      $.put(BIAS, $.i(72));
      $.put(EA, $.i(-1));
      $.for(J, $.l(F), $.l(T), () => $.if($.eq(at($.l(J)), $.i(45)), () => $.put(EA, $.l(J))));
      $.if($.ge($.l(EA), $.i(0)), () => {
        $.for(J, $.l(F), $.l(EA), () => {
          $.if($.ge(at($.l(J)), $.i(0x80)), nul);
          this.cpush($, $.l(OUT), at($.l(J)));
          $.put(WO, $.add($.l(WO), $.i(1)));
        });
        $.put(F, $.add($.l(EA), $.i(1)));
      });
      $.while($.lt($.l(F), $.l(T)), () => {
        $.put(OLDI, $.l(I));
        $.put(W, $.i(1));
        $.put(K, $.i(36));
        $.put(GO, $.i(1));
        $.while($.l(GO), () => {
          $.if($.ge($.l(F), $.l(T)), nul);
          $.put(C, at($.l(F)));
          $.put(F, $.add($.l(F), $.i(1)));
          $.put(DG, $.sel(I32, $.both($.ge($.l(C), $.i(97)), $.le($.l(C), $.i(122))), $.sub($.l(C), $.i(97)), $.sel(I32, $.both($.ge($.l(C), $.i(48)), $.le($.l(C), $.i(57))), $.sub($.l(C), $.i(22)), $.i(-1))));
          $.if($.lt($.l(DG), $.i(0)), nul);
          $.if($.gt($.l(DG), sdiv($.sub($.i(0x7fffffff), $.l(I)), $.l(W))), nul);
          $.put(I, $.add($.l(I), $.mul($.l(DG), $.l(W))));
          $.put(TT, $.sel(I32, $.le($.l(K), $.l(BIAS)), $.i(1), $.sel(I32, $.ge($.l(K), $.add($.l(BIAS), $.i(26))), $.i(26), $.sub($.l(K), $.l(BIAS)))));
          $.if($.lt($.l(DG), $.l(TT)), () => $.put(GO, $.i(0)), () => {
            $.if($.gt($.l(W), sdiv($.i(0x7fffffff), $.sub($.i(36), $.l(TT)))), nul);
            $.put(W, $.mul($.l(W), $.sub($.i(36), $.l(TT))));
            $.put(K, $.add($.l(K), $.i(36)));
          });
        });
        $.put(BIAS, $.call(this.adaptFn(), $.sub($.l(I), $.l(OLDI)), $.add($.l(WO), $.i(1)), $.not($.l(OLDI))));
        $.if($.gt(sdiv($.l(I), $.add($.l(WO), $.i(1))), $.sub($.i(0x7fffffff), $.l(N))), nul);
        $.put(N, $.add($.l(N), sdiv($.l(I), $.add($.l(WO), $.i(1)))));
        $.put(I, srem($.l(I), $.add($.l(WO), $.i(1))));
        $.if($.ltU($.l(N), $.i(0x80)), nul);
        // out.insert(out.begin() + i, n)
        this.cpush($, $.l(OUT), $.i(0));
        $.put(J, $.sub(this.clen($, $.l(OUT)), $.i(1)));
        $.while($.gt($.l(J), $.l(I)), () => {
          this.cset($, $.l(OUT), $.l(J), this.cat($, $.l(OUT), $.sub($.l(J), $.i(1))));
          $.put(J, $.sub($.l(J), $.i(1)));
        });
        this.cset($, $.l(OUT), $.l(I), $.l(N));
        $.put(WO, $.add($.l(WO), $.i(1)));
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.do($.l(OUT));
    });
  }

  /** utf32_to_punycode(label) appended to out (bytes as code points);
   * false on failure. */
  private punyEncodeFn(): number {
    return this.fn("punyEncode", [this.cbRef, this.cbRef], [I32], (f, $) => {
      const [IN, OUT] = [0, 1];
      const N = f.local(I32);
      const D = f.local(I32);
      const BIAS = f.local(I32);
      const H = f.local(I32);
      const B = f.local(I32);
      const I = f.local(I32);
      const C = f.local(I32);
      const M = f.local(I32);
      const Q = f.local(I32);
      const K = f.local(I32);
      const TT = f.local(I32);
      const GO = f.local(I32);
      const LEN = f.local(I32);
      const sdiv = (a: X, b: X): X => () => {
        a();
        b();
        $.c.i32DivS();
      };
      const srem = (a: X, b: X): X => () => {
        a();
        b();
        $.c.i32RemS();
      };
      const dch = (d: X): X => $.sel(I32, $.lt(d, $.i(26)), $.add(d, $.i(97)), $.add(d, $.i(22)));
      $.put(N, $.i(128));
      $.put(BIAS, $.i(72));
      $.put(LEN, this.clen($, $.l(IN)));
      $.for(I, $.i(0), $.l(LEN), () => {
        $.put(C, this.cat($, $.l(IN), $.l(I)));
        $.if($.ltU($.l(C), $.i(0x80)), () => {
          $.put(H, $.add($.l(H), $.i(1)));
          this.cpush($, $.l(OUT), $.l(C));
        });
        $.if($.either($.gtU($.l(C), $.i(0x10ffff)), $.both($.geU($.l(C), $.i(0xd800)), $.ltU($.l(C), $.i(0xe000)))), () => $.ret($.i(0)));
      });
      $.put(B, $.l(H));
      $.if($.gt($.l(B), $.i(0)), () => this.cpush($, $.l(OUT), $.i(45)));
      $.while($.lt($.l(H), $.l(LEN)), () => {
        $.put(M, $.i(0x10ffff));
        $.for(I, $.i(0), $.l(LEN), () => {
          $.put(C, this.cat($, $.l(IN), $.l(I)));
          $.if($.both($.geU($.l(C), $.l(N)), $.ltU($.l(C), $.l(M))), () => $.put(M, $.l(C)));
        });
        $.if($.gtU($.sub($.l(M), $.l(N)), sdiv($.sub($.i(0x7fffffff), $.l(D)), $.add($.l(H), $.i(1)))), () => $.ret($.i(0)));
        $.put(D, $.add($.l(D), $.mul($.sub($.l(M), $.l(N)), $.add($.l(H), $.i(1)))));
        $.put(N, $.l(M));
        $.for(I, $.i(0), $.l(LEN), () => {
          $.put(C, this.cat($, $.l(IN), $.l(I)));
          $.if($.ltU($.l(C), $.l(N)), () => {
            $.if($.eq($.l(D), $.i(0x7fffffff)), () => $.ret($.i(0)));
            $.put(D, $.add($.l(D), $.i(1)));
          });
          $.if($.eq($.l(C), $.l(N)), () => {
            $.put(Q, $.l(D));
            $.put(K, $.i(36));
            $.put(GO, $.i(1));
            $.while($.l(GO), () => {
              $.put(TT, $.sel(I32, $.le($.l(K), $.l(BIAS)), $.i(1), $.sel(I32, $.ge($.l(K), $.add($.l(BIAS), $.i(26))), $.i(26), $.sub($.l(K), $.l(BIAS)))));
              $.if($.lt($.l(Q), $.l(TT)), () => $.put(GO, $.i(0)), () => {
                this.cpush($, $.l(OUT), dch($.add($.l(TT), srem($.sub($.l(Q), $.l(TT)), $.sub($.i(36), $.l(TT))))));
                $.put(Q, sdiv($.sub($.l(Q), $.l(TT)), $.sub($.i(36), $.l(TT))));
                $.put(K, $.add($.l(K), $.i(36)));
              });
            });
            this.cpush($, $.l(OUT), dch($.l(Q)));
            $.put(BIAS, $.call(this.adaptFn(), $.l(D), $.add($.l(H), $.i(1)), $.eq($.l(H), $.l(B))));
            $.put(D, $.i(0));
            $.put(H, $.add($.l(H), $.i(1)));
          });
        });
        $.put(D, $.add($.l(D), $.i(1)));
        $.put(N, $.add($.l(N), $.i(1)));
      });
      $.do($.i(1));
    });
  }

  /* ── validity.cpp ─────────────────────────────────────────────────── */

  private directionFn(): number {
    return this.fn("direction", [I32], [I32], (f, $) => {
      const C = 0;
      const LO = f.local(I32);
      const HI = f.local(I32);
      const MID = f.local(I32);
      const n = this.tableGlobal("dirStart").len;
      // lower_bound: the first entry whose final_code >= c
      $.put(HI, $.i(n));
      $.while($.lt($.l(LO), $.l(HI)), () => {
        $.put(MID, $.shrU($.add($.l(LO), $.l(HI)), $.i(1)));
        $.if($.ltU(this.tget($, "dirFinal", $.l(MID)), $.l(C)), () => $.put(LO, $.add($.l(MID), $.i(1))), () => $.put(HI, $.l(MID)));
      });
      $.if($.eq($.l(LO), $.i(n)), () => $.ret($.i(0)));
      $.if($.geU($.l(C), this.tget($, "dirStart", $.l(LO))), () => $.ret(this.tget($, "dirDir", $.l(LO))));
      $.do($.i(0));
    });
  }

  private inList($: A, v: X, list: readonly number[]): X {
    let x = $.eq(v, $.i(list[0]!));
    for (let i = 1; i < list.length; i++) x = $.either(x, $.eq(v, $.i(list[i]!)));
    return x;
  }

  private combiningFn(): number {
    return this.fn("isCombining", [I32], [I32], (f, $) => {
      const C = 0;
      const LO = f.local(I32);
      const HI = f.local(I32);
      const MID = f.local(I32);
      const MV = f.local(I32);
      $.put(HI, $.i(this.tableGlobal("combining").len - 1));
      $.while($.le($.l(LO), $.l(HI)), () => {
        $.put(MID, $.shrU($.add($.l(LO), $.l(HI)), $.i(1)));
        $.put(MV, this.tget($, "combining", $.l(MID)));
        $.if($.eq($.l(MV), $.l(C)), () => $.ret($.i(1)));
        $.if($.ltU($.l(MV), $.l(C)), () => $.put(LO, $.add($.l(MID), $.i(1))), () => $.put(HI, $.sub($.l(MID), $.i(1))));
      });
      $.do($.i(0));
    });
  }

  /** is_label_valid(label) */
  private labelValidFn(): number {
    return this.fn("labelValid", [this.cbRef], [I32], (f, $) => {
      const L = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const C = f.local(I32);
      const J = f.local(I32);
      const FB = f.local(I32);
      const FA = f.local(I32);
      const LAST = f.local(I32);
      const D = f.local(I32);
      const MASK = f.local(I32);
      const HAN = f.local(I32);
      const HEN = f.local(I32);
      const at = (i: X): X => this.cat($, $.l(L), i);
      const dir = (i: X): X => $.call(this.directionFn(), at(i));
      const isD = (d: X, ds: number[]): X => {
        let x = $.eq(d, $.i(ds[0]!));
        for (let k = 1; k < ds.length; k++) x = $.either(x, $.eq(d, $.i(ds[k]!)));
        return x;
      };
      $.put(N, this.clen($, $.l(L)));
      $.if($.not($.l(N)), () => $.ret($.i(1)));
      $.if($.call(this.combiningFn(), at($.i(0))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(C, at($.l(I)));
        $.if($.eq($.l(C), $.i(0x200c)), () => {
          $.if($.andThen($.gt($.l(I), $.i(0)), this.inList($, at($.sub($.l(I), $.i(1))), URL_VIRAMA)), () => $.ret($.i(1)));
          $.if($.either($.not($.l(I)), $.ge($.add($.l(I), $.i(1)), $.l(N))), () => $.ret($.i(0)));
          $.put(FB, $.i(0));
          $.for(J, $.i(0), $.l(I), () => $.if($.either(this.inList($, at($.l(J)), URL_JOIN_L), this.inList($, at($.l(J)), URL_JOIN_D)), () => $.put(FB, $.i(1))));
          $.put(FA, $.i(0));
          $.for(J, $.add($.l(I), $.i(1)), $.l(N), () => $.if($.either(this.inList($, at($.l(J)), URL_JOIN_R), this.inList($, at($.l(J)), URL_JOIN_D)), () => $.put(FA, $.i(1))));
          $.ret($.both($.l(FB), $.l(FA)));
        });
        $.if($.eq($.l(C), $.i(0x200d)), () => {
          $.if($.andThen($.gt($.l(I), $.i(0)), this.inList($, at($.sub($.l(I), $.i(1))), URL_VIRAMA)), () => $.ret($.i(1)));
          $.ret($.i(0));
        });
      });
      // find_last_not_of_nsm
      $.put(LAST, $.i(-1));
      $.put(I, $.sub($.l(N), $.i(1)));
      $.while($.both($.ge($.l(I), $.i(0)), $.lt($.l(LAST), $.i(0))), () => {
        $.if($.ne(dir($.l(I)), $.i(D_NSM)), () => $.put(LAST, $.l(I)));
        $.put(I, $.sub($.l(I), $.i(1)));
      });
      $.if($.lt($.l(LAST), $.i(0)), () => $.ret($.i(0)));
      // is_rtl_label
      $.put(MASK, $.i(0));
      $.for(I, $.i(0), $.l(N), () => $.put(MASK, $.or($.l(MASK), $.shl($.i(1), dir($.l(I))))));
      $.if($.and($.l(MASK), $.i((1 << D_R) | (1 << D_AL) | (1 << D_AN))), () => {
        $.if($.eq(dir($.i(0)), $.i(D_L)), () => {
          $.for(I, $.i(0), $.l(LAST), () => {
            $.put(D, dir($.l(I)));
            $.if($.not(isD($.l(D), [D_L, D_EN, D_ES, D_CS, D_ET, D_ON, D_BN, D_NSM])), () => $.ret($.i(0)));
          });
          $.ret($.i(1));
        });
        $.for(I, $.i(0), $.add($.l(LAST), $.i(1)), () => {
          $.put(D, dir($.l(I)));
          $.if($.eq($.l(D), $.i(D_EN)), () => {
            $.put(HEN, $.i(1));
            $.if($.l(HAN), () => $.ret($.i(0)));
          });
          $.if($.eq($.l(D), $.i(D_AN)), () => {
            $.put(HAN, $.i(1));
            $.if($.l(HEN), () => $.ret($.i(0)));
          });
          $.if($.not(isD($.l(D), [D_R, D_AL, D_AN, D_EN, D_ES, D_CS, D_ET, D_ON, D_BN, D_NSM])), () => $.ret($.i(0)));
          $.if($.both($.eq($.l(I), $.l(LAST)), $.not(isD($.l(D), [D_R, D_AL, D_AN, D_EN]))), () => $.ret($.i(0)));
        });
        $.ret($.i(1));
      });
      $.do($.i(1));
    });
  }

  /* ── to_ascii.cpp ─────────────────────────────────────────────────── */

  /** The checks of an "xn--" label's punycode part bytes[from, to):
   * decodes, must be non-ASCII, map-stable, NFC-stable, non-empty and
   * valid. */
  private xnLabelOkFn(): number {
    return this.fn("xnLabelOk", [this.bRef, I32, I32], [I32], (f, $) => {
      const [BY, F, T] = [0, 1, 2];
      const TMP = f.local(this.cbRef);
      const POST = f.local(this.cbRef);
      const NORM = f.local(this.cbRef);
      $.put(TMP, $.call(this.punyDecodeFn(), $.l(BY), $.l(F), $.l(T)));
      $.if($.isNull($.l(TMP)), () => $.ret($.i(0)));
      $.if($.call(this.cbAsciiFn(), $.l(TMP)), () => $.ret($.i(0)));
      $.put(POST, $.call(this.mapFn(), $.l(TMP)));
      $.if($.isNull($.l(POST)), () => $.ret($.i(0)));
      $.if($.not($.call(this.cbEqFn(), $.l(TMP), $.l(POST))), () => $.ret($.i(0)));
      $.put(NORM, $.call(this.normalizeFn(), $.l(POST)));
      $.if($.not($.call(this.cbEqFn(), $.l(NORM), $.l(POST))), () => $.ret($.i(0)));
      $.if($.not(this.clen($, $.l(NORM))), () => $.ret($.i(0)));
      $.do($.call(this.labelValidFn(), $.l(NORM)));
    });
  }

  /** ada::idna::to_ascii(bytes[from, to)): the ASCII domain, or null
   * (ada's "" — an error). */
  toAsciiFn(): number {
    return this.fn("toAscii", [this.bRef, I32, I32], [this.bRef], (f, $) => {
      const [BY, F, T] = [0, 1, 2];
      const I = f.local(I32);
      const ASCII = f.local(I32);
      const U = f.local(this.cbRef);
      const OUT = f.local(this.cbRef);
      const LS = f.local(I32);
      const LE = f.local(I32);
      const N = f.local(I32);
      const LAB = f.local(this.cbRef);
      const OB = f.local(this.bRef);
      const MB = f.local(this.bRef);
      const B = f.local(I32);
      const OS = f.local(I32);
      const nul = (): void => $.ret($.nul(this.B8));
      $.run(this.initFn());
      $.put(ASCII, $.i(1));
      $.for(I, $.l(F), $.l(T), () => $.if($.ge($.agetU(this.B8, $.l(BY), $.l(I)), $.i(0x80)), () => $.put(ASCII, $.i(0))));
      $.put(OUT, this.cbNew($, $.add($.sub($.l(T), $.l(F)), $.i(8))));
      $.if($.l(ASCII), () => {
        // from_ascii_to_ascii: lowercase, then each "xn--" label checked
        $.put(N, $.sub($.l(T), $.l(F)));
        $.put(MB, $.anew(this.B8, $.l(N)));
        $.for(I, $.i(0), $.l(N), () => {
          $.put(B, $.agetU(this.B8, $.l(BY), $.add($.l(F), $.l(I))));
          $.if($.both($.ge($.l(B), $.i(65)), $.le($.l(B), $.i(90))), () => $.put(B, $.add($.l(B), $.i(32))));
          $.aset(this.B8, $.l(MB), $.l(I), $.l(B));
        });
        $.put(LS, $.i(0));
        $.while($.ne($.l(LS), $.l(N)), () => {
          $.put(LE, $.l(LS));
          $.while($.andThen($.lt($.l(LE), $.l(N)), $.ne($.agetU(this.B8, $.l(MB), $.l(LE)), $.i(46))), () => $.put(LE, $.add($.l(LE), $.i(1))));
          $.for(I, $.l(LS), $.l(LE), () => this.cpush($, $.l(OUT), $.agetU(this.B8, $.l(MB), $.l(I))));
          $.if($.call(this.startsXnFn(), $.l(MB), $.l(LS), $.l(LE)), () => {
            $.if($.not($.call(this.xnLabelOkFn(), $.l(MB), $.add($.l(LS), $.i(4)), $.l(LE))), nul);
          });
          $.if($.lt($.l(LE), $.l(N)), () => {
            this.cpush($, $.l(OUT), $.i(46));
            $.put(LS, $.add($.l(LE), $.i(1)));
          }, () => $.put(LS, $.l(LE)));
        });
        $.ret($.call(this.cbToBytesFn(), $.l(OUT)));
      });
      $.put(U, $.call(this.utf8ToUtf32Fn(), $.l(BY), $.l(F), $.l(T)));
      $.if($.isNull($.l(U)), nul);
      $.put(U, $.call(this.mapFn(), $.l(U)));
      $.if($.isNull($.l(U)), nul);
      $.put(U, $.call(this.normalizeFn(), $.l(U)));
      $.put(N, this.clen($, $.l(U)));
      $.put(LS, $.i(0));
      $.while($.ne($.l(LS), $.l(N)), () => {
        $.put(LE, $.l(LS));
        $.while($.andThen($.lt($.l(LE), $.l(N)), $.ne(this.cat($, $.l(U), $.l(LE)), $.i(46))), () => $.put(LE, $.add($.l(LE), $.i(1))));
        $.if($.ne($.l(LE), $.l(LS)), () => {
          $.put(LAB, $.call(this.cbSliceFn(), $.l(U), $.l(LS), $.l(LE)));
          $.if($.call(this.cbStartsXnFn(), $.l(LAB)), () => {
            $.put(OS, this.clen($, $.l(OUT)));
            $.for(I, $.i(0), this.clen($, $.l(LAB)), () => {
              $.if($.geU(this.cat($, $.l(LAB), $.l(I)), $.i(0x80)), nul);
              this.cpush($, $.l(OUT), this.cat($, $.l(LAB), $.l(I)));
            });
            $.put(OB, $.call(this.cbToBytesFn(), $.l(OUT)));
            $.if($.not($.call(this.xnLabelOkFn(), $.l(OB), $.add($.l(OS), $.i(4)), $.alen($.l(OB)))), nul);
          }, () => {
            $.if($.call(this.cbAsciiFn(), $.l(LAB)), () => {
              $.for(I, $.i(0), this.clen($, $.l(LAB)), () => this.cpush($, $.l(OUT), this.cat($, $.l(LAB), $.l(I))));
            }, () => {
              $.if($.not($.call(this.labelValidFn(), $.l(LAB))), nul);
              for (const ch of "xn--") this.cpush($, $.l(OUT), $.i(ch.charCodeAt(0)));
              $.if($.not($.call(this.punyEncodeFn(), $.l(LAB), $.l(OUT))), nul);
            });
          });
        });
        $.if($.lt($.l(LE), $.l(N)), () => {
          this.cpush($, $.l(OUT), $.i(46));
          $.put(LS, $.add($.l(LE), $.i(1)));
        }, () => $.put(LS, $.l(LE)));
      });
      $.do($.call(this.cbToBytesFn(), $.l(OUT)));
    });
  }

  private startsXnFn(): number {
    return this.fn("startsXn", [this.bRef, I32, I32], [I32], (_f, $) => {
      const [BY, F, T] = [0, 1, 2];
      const at = (k: number): X => $.agetU(this.B8, $.l(BY), $.add($.l(F), $.i(k)));
      $.if($.lt($.sub($.l(T), $.l(F)), $.i(4)), () => $.ret($.i(0)));
      $.do($.both($.both($.eq(at(0), $.i(120)), $.eq(at(1), $.i(110))), $.both($.eq(at(2), $.i(45)), $.eq(at(3), $.i(45)))));
    });
  }
  private cbStartsXnFn(): number {
    return this.fn("cbStartsXn", [this.cbRef], [I32], (_f, $) => {
      const at = (k: number): X => this.cat($, $.l(0), $.i(k));
      $.if($.lt(this.clen($, $.l(0)), $.i(4)), () => $.ret($.i(0)));
      $.do($.both($.both($.eq(at(0), $.i(120)), $.eq(at(1), $.i(110))), $.both($.eq(at(2), $.i(45)), $.eq(at(3), $.i(45)))));
    });
  }
}
