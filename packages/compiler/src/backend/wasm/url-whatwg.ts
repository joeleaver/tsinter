/* INC-29 U3 — the WHATWG URL on the WasmGC tier: Node v24.18.1's URL
 * parser (its vendored ada 3.4.4, deps/ada) and its lib/internal/url.js
 * surface, built in the module with no host import.
 *
 * THE PARSER is ada's parse_url_impl (src/parser.cpp) over the input's
 * UTF-8 bytes (Node hands ada a Utf8Value, so a lone surrogate arrives as
 * U+FFFD), transcribed state for state with ada::url's component model:
 * scheme, username, password, host (null or a string), port (-1 = null),
 * path, the opaque-path flag, query and fragment. Node runs ada's
 * url_aggregator; the two share the parser and every helper that decides
 * an observable byte (parse_host, parse_ipv4/ipv6, parse_port, the
 * percent-encode sets, parse_prepared_path's general case, which its
 * trivial and fast paths only shortcut), and the getters below answer what
 * lib/internal/url.js slices out of the aggregator's href. One builder
 * makes two parsers: `parse` (no base — a scheme-less input fails, as in
 * Node) and `parseBase` (a non-null, already-parsed base: ada's NO_SCHEME,
 * SPECIAL_RELATIVE_OR_AUTHORITY, RELATIVE_SCHEME and RELATIVE_SLASH states
 * and the FILE / FILE_SLASH base arms), so the base-less function's bytes
 * are what they were before the base existed.
 *
 * Every component the parser produces is ASCII (non-ASCII bytes are
 * percent-encoded or IDNA-encoded), so components are built as bytes and
 * become JS strings by zero-extension.
 *
 * Hosts: special-scheme domains run domain-to-ASCII (url-idna.ts, ada's
 * idna with its UTS #46 tables); opaque hosts percent-encode; IPv4 accepts
 * the WHATWG decimal/octal/hex forms and IPv6 serializes with the longest
 * zero run compressed — ada's parse_ipv4 / parse_ipv6 / serializers.
 *
 * URLSearchParams and the URL's live searchParams view are
 * lib/internal/url.js: the list is name/value strings, the urlencoded
 * parser is parseParams (with querystring.unescape's decodeURIComponent-
 * then-unescapeBuffer fallback), the serializer is serializeParams over
 * encodeStr's noEscape table, sort is Node's stable insertion / merge
 * sort. A view's mutation re-serializes into its URL's query at once
 * (Node does it lazily, on the next read — unobservable). */
import { A, Fn, type X } from "./asm.js";
import { F64, I32, I64, ModuleBuilder, type ValType } from "./module.js";
import { BUF, LEN, type VecInfo } from "./arrays.js";
import { URL_PCT_SETS, urlTableBytes } from "./url-tables.js";
import type { Code } from "./code.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/** ada::scheme::type */
export const T_HTTP = 0;
export const T_NOT_SPECIAL = 1;
export const T_HTTPS = 2;
export const T_WS = 3;
export const T_FTP = 4;
export const T_WSS = 5;
export const T_FILE = 6;
const SCHEMES: [string, number][] = [["http", T_HTTP], ["https", T_HTTPS], ["ws", T_WS], ["ftp", T_FTP], ["wss", T_WSS], ["file", T_FILE]];
const DEFAULT_PORTS = [80, 0, 443, 80, 21, 443, 0];

/** Percent-encode sets, URL_PCT_SETS order. */
const SET_C0 = 0;
const SET_SPECIAL_QUERY = 1;
const SET_QUERY = 2;
const SET_FRAGMENT = 3;
const SET_USERINFO = 4;
const SET_PATH = 5;

/** $url fields */
export const U_SCHEME = 0;
export const U_TYPE = 1;
export const U_USER = 2;
export const U_PASS = 3;
export const U_HOST = 4;
export const U_PORT = 5;
export const U_PATH = 6;
export const U_OPAQUE = 7;
export const U_QUERY = 8;
export const U_FRAG = 9;
export const U_SP = 10;
/** $sp fields */
const SP_LIST = 0;
const SP_N = 1;
const SP_URL = 2;
/** $ob (a growable byte buffer) fields */
const OB_A = 0;
const OB_N = 1;

/* parser states (ada::state) */
const ST_FILE = 1;
const ST_FILE_SLASH = 2;
const ST_FILE_HOST = 3;
const ST_SAS = 4; // SPECIAL_AUTHORITY_SLASHES
const ST_SAIS = 5; // SPECIAL_AUTHORITY_IGNORE_SLASHES
const ST_POA = 6; // PATH_OR_AUTHORITY
const ST_AUTHORITY = 7;
const ST_HOST = 8;
const ST_PORT = 9;
const ST_PATH_START = 10;
const ST_PATH = 11;
const ST_OPAQUE = 12;
const ST_QUERY = 13;
/* the states only a base reaches */
const ST_NO_SCHEME = 14;
const ST_SROA = 15; // SPECIAL_RELATIVE_OR_AUTHORITY
const ST_REL = 16; // RELATIVE_SCHEME
const ST_REL_SLASH = 17; // RELATIVE_SLASH

export interface UrlEngineDeps {
  strRef: () => ValType;
  strType: () => number;
  lit: (c: Code, s: string) => void;
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
  /** The pending-exception kind global (nonzero = pending). */
  excKind: () => number;
  /** `(str) -> str` decodeURIComponent; a malformed input leaves Node's
   * URIError pending. */
  decodeUriComponent: () => number;
  /** `(str) -> str` path.posix.resolve(str) against the cwd. */
  resolve1: () => number;
  /** string[] and string[][] vectors. */
  strVec: () => VecInfo;
  strVecVec: () => VecInfo;
  /** `(B8, from, to) -> B8 | null` — ada::idna::to_ascii over UTF-8
   * bytes ("" on error is null here). */
  idnaToAscii: () => number;
}

export class UrlEngine {
  private readonly fns = new Map<string, number>();
  private urlT_: number | null = null;
  private spT_: number | null = null;
  private obT_: number | null = null;
  private setsG: number | null = null;
  private setsOff = 0;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: UrlEngineDeps,
  ) {}

  /* ── plumbing ─────────────────────────────────────────────────────── */

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.url.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }

  get B8(): number {
    return this.mb.arrayType("i8", true);
  }
  get I32A(): number {
    return this.mb.arrayType(I32, true);
  }
  private get S(): number {
    return this.deps.strType();
  }
  private get sRef(): ValType {
    return this.deps.strRef();
  }
  private get bRef(): ValType {
    return this.ref(this.B8);
  }
  /** The string list's backing array — the same type a string[] vector's
   * buffer has. */
  private get listT(): number {
    return this.deps.strVec().bufType;
  }

  urlType(): number {
    this.urlT_ ??= this.mb.openStructType("url:URL", [
      { storage: this.sRef, mutable: false }, // scheme
      { storage: I32, mutable: false }, // type
      { storage: this.sRef, mutable: false }, // username
      { storage: this.sRef, mutable: false }, // password
      { storage: this.sRef, mutable: false }, // host (null = none)
      { storage: I32, mutable: false }, // port (-1 = none)
      { storage: this.sRef, mutable: false }, // path
      { storage: I32, mutable: false }, // opaque path
      { storage: this.sRef, mutable: true }, // query (null = none)
      { storage: this.sRef, mutable: false }, // fragment (null = none)
      { storage: EQ_REF, mutable: true }, // the searchParams view
    ]);
    return this.urlT_;
  }
  urlRef(): ValType {
    return this.ref(this.urlType());
  }
  spType(): number {
    this.spT_ ??= this.mb.openStructType("url:URLSearchParams", [
      { storage: this.ref(this.listT), mutable: true },
      { storage: I32, mutable: true },
      { storage: this.urlRef(), mutable: true },
    ]);
    return this.spT_;
  }
  spRef(): ValType {
    return this.ref(this.spType());
  }
  private get OB(): number {
    this.obT_ ??= this.mb.openStructType("url:bytebuf", [
      { storage: this.bRef, mutable: true },
      { storage: I32, mutable: true },
    ]);
    return this.obT_;
  }
  private get obRef(): ValType {
    return this.ref(this.OB);
  }

  private lit($: A, s: string): X {
    return () => this.deps.lit($.c, s);
  }

  private u8($: A, arr: X, i: X): X {
    return $.agetU(this.B8, arr, i);
  }

  private throwType($: A, msg: string, code: string): void {
    this.deps.setCellError($.c, "%TypeError", "TypeError", (c) => this.deps.lit(c, msg), code);
  }

  private pending($: A): X {
    return $.g(this.deps.excKind());
  }

  /* ── byte buffers ─────────────────────────────────────────────────── */

  obNew($: A): X {
    return $.new_(this.OB, $.anew(this.B8, $.i(16)), $.i(0));
  }

  /** ob.push(byte) */
  obPushFn(): number {
    return this.fn("obPush", [this.obRef, I32], [], (f, $) => {
      const [O, V] = [0, 1];
      const N = f.local(I32);
      const NA = f.local(this.bRef);
      $.put(N, $.get(this.OB, OB_N, $.l(O)));
      $.if($.ge($.l(N), $.alen($.get(this.OB, OB_A, $.l(O)))), () => {
        $.put(NA, $.anew(this.B8, $.add($.mul($.l(N), $.i(2)), $.i(8))));
        $.do($.l(NA), $.i(0), $.get(this.OB, OB_A, $.l(O)), $.i(0), $.l(N));
        $.c.arrayCopy(this.B8, this.B8);
        $.set(this.OB, OB_A, $.l(O), $.l(NA));
      });
      $.aset(this.B8, $.get(this.OB, OB_A, $.l(O)), $.l(N), $.l(V));
      $.set(this.OB, OB_N, $.l(O), $.add($.l(N), $.i(1)));
    });
  }
  private push($: A, ob: X, b: X): void {
    $.run(this.obPushFn(), ob, b);
  }
  private pushLit($: A, ob: X, s: string): void {
    for (let i = 0; i < s.length; i++) this.push($, ob, $.i(s.charCodeAt(i)));
  }

  /** ob.append(arr[from, to)) */
  obAppendFn(): number {
    return this.fn("obAppend", [this.obRef, this.bRef, I32, I32], [], (f, $) => {
      const [O, ARR, FROM, TO] = [0, 1, 2, 3];
      const I = f.local(I32);
      $.for(I, $.l(FROM), $.l(TO), () => this.push($, $.l(O), this.u8($, $.l(ARR), $.l(I))));
    });
  }
  /** ob.append(ASCII string) */
  obAppendStrFn(): number {
    return this.fn("obAppendStr", [this.obRef, this.sRef], [], (f, $) => {
      const [O, STR] = [0, 1];
      const I = f.local(I32);
      $.for(I, $.i(0), $.alen($.l(STR)), () => this.push($, $.l(O), $.and($.agetU(this.S, $.l(STR), $.l(I)), $.i(0xff))));
    });
  }
  /** ob -> string (zero-extended bytes) */
  obToStrFn(): number {
    return this.fn("obToStr", [this.obRef], [this.sRef], (f, $) => {
      const O = 0;
      const R = f.local(this.sRef);
      const I = f.local(I32);
      $.put(R, $.anew(this.S, $.get(this.OB, OB_N, $.l(O))));
      $.for(I, $.i(0), $.get(this.OB, OB_N, $.l(O)), () => {
        $.aset(this.S, $.l(R), $.l(I), this.u8($, $.get(this.OB, OB_A, $.l(O)), $.l(I)));
      });
      $.do($.l(R));
    });
  }
  /** ob -> exact-length bytes */
  obToBytesFn(): number {
    return this.fn("obToBytes", [this.obRef], [this.bRef], (f, $) => {
      const O = 0;
      const R = f.local(this.bRef);
      $.put(R, $.anew(this.B8, $.get(this.OB, OB_N, $.l(O))));
      $.do($.l(R), $.i(0), $.get(this.OB, OB_A, $.l(O)), $.i(0), $.get(this.OB, OB_N, $.l(O)));
      $.c.arrayCopy(this.B8, this.B8);
      $.do($.l(R));
    });
  }
  private obStr($: A, ob: X): X {
    return $.call(this.obToStrFn(), ob);
  }
  private obAt($: A, ob: X, i: X): X {
    return this.u8($, $.get(this.OB, OB_A, ob), i);
  }
  private obLen($: A, ob: X): X {
    return $.get(this.OB, OB_N, ob);
  }

  /** bytes[from, to) -> string */
  rangeStrFn(): number {
    return this.fn("rangeStr", [this.bRef, I32, I32], [this.sRef], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const R = f.local(this.sRef);
      const I = f.local(I32);
      $.put(R, $.anew(this.S, $.sub($.l(TO), $.l(FROM))));
      $.for(I, $.l(FROM), $.l(TO), () => $.aset(this.S, $.l(R), $.sub($.l(I), $.l(FROM)), this.u8($, $.l(ARR), $.l(I))));
      $.do($.l(R));
    });
  }

  /** The first index in [from, to) holding `b`, else `to`. */
  findFn(): number {
    return this.fn("find", [this.bRef, I32, I32, I32], [I32], (f, $) => {
      const [ARR, FROM, TO, B] = [0, 1, 2, 3];
      const I = f.local(I32);
      $.for(I, $.l(FROM), $.l(TO), () => {
        $.if($.eq(this.u8($, $.l(ARR), $.l(I)), $.l(B)), () => $.ret($.l(I)));
      });
      $.do($.l(TO));
    });
  }
  private find($: A, arr: X, from: X, to: X, b: number): X {
    return $.call(this.findFn(), arr, from, to, $.i(b));
  }

  /* ── UTF-8 (V8's Utf8Value: a lone surrogate writes U+FFFD) ─────────── */

  utf8Fn(): number {
    return this.fn("utf8", [this.sRef], [this.bRef], (f, $) => {
      const STR = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const C = f.local(I32);
      const D = f.local(I32);
      const LEN = f.local(I32);
      const R = f.local(this.bRef);
      const O = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      // Pass 1 sizes, pass 2 writes; a pair is one 4-byte code point.
      for (const pass of [1, 2]) {
        $.put(I, $.i(0));
        $.put(N, $.alen($.l(STR)));
        if (pass === 1) $.put(LEN, $.i(0));
        else {
          $.put(R, $.anew(this.B8, $.l(LEN)));
          $.put(O, $.i(0));
        }
        $.while($.lt($.l(I), $.l(N)), () => {
          $.put(C, cu($.l(I)));
          $.put(I, $.add($.l(I), $.i(1)));
          // combine a valid surrogate pair; a lone half becomes U+FFFD
          $.if($.eq($.and($.l(C), $.i(0xfc00)), $.i(0xd800)), () => {
            $.if(
              $.andThen($.lt($.l(I), $.l(N)), $.eq($.and(cu($.l(I)), $.i(0xfc00)), $.i(0xdc00))),
              () => {
                $.put(D, cu($.l(I)));
                $.put(I, $.add($.l(I), $.i(1)));
                $.put(C, $.add($.i(0x10000), $.add($.shl($.sub($.l(C), $.i(0xd800)), $.i(10)), $.sub($.l(D), $.i(0xdc00)))));
              },
              () => $.put(C, $.i(0xfffd)),
            );
          }, () => {
            $.if($.eq($.and($.l(C), $.i(0xfc00)), $.i(0xdc00)), () => $.put(C, $.i(0xfffd)));
          });
          const len = $.sel(I32, $.lt($.l(C), $.i(0x80)), $.i(1), $.sel(I32, $.lt($.l(C), $.i(0x800)), $.i(2), $.sel(I32, $.lt($.l(C), $.i(0x10000)), $.i(3), $.i(4))));
          if (pass === 1) {
            $.put(LEN, $.add($.l(LEN), len));
          } else {
            const put = (v: X): void => {
              $.aset(this.B8, $.l(R), $.l(O), v);
              $.put(O, $.add($.l(O), $.i(1)));
            };
            $.if($.lt($.l(C), $.i(0x80)), () => put($.l(C)), () => {
              $.if($.lt($.l(C), $.i(0x800)), () => {
                put($.or($.i(0xc0), $.shrU($.l(C), $.i(6))));
              }, () => {
                $.if($.lt($.l(C), $.i(0x10000)), () => {
                  put($.or($.i(0xe0), $.shrU($.l(C), $.i(12))));
                }, () => {
                  put($.or($.i(0xf0), $.shrU($.l(C), $.i(18))));
                  put($.or($.i(0x80), $.and($.shrU($.l(C), $.i(12)), $.i(0x3f))));
                });
                put($.or($.i(0x80), $.and($.shrU($.l(C), $.i(6)), $.i(0x3f))));
              });
              put($.or($.i(0x80), $.and($.l(C), $.i(0x3f))));
            });
          }
        });
      }
      $.do($.l(R));
    });
  }

  /* ── percent-encoding (ada::character_sets, ada::unicode) ─────────── */

  private setsGlobal(): number {
    if (this.setsG === null) {
      this.setsOff = this.mb.internData(urlTableBytes(URL_PCT_SETS));
      this.setsG = this.mb.addGlobal(this.bRef, true, (w) => {
        w.u8(0xd0);
        w.sleb(this.B8);
      });
    }
    return this.setsG;
  }
  /** The sets array, materialized on first use. */
  setsFn(): number {
    return this.fn("pctSets", [], [this.bRef], (_f, $) => {
      const g = this.setsGlobal();
      $.if($.isNull($.g(g)), () => {
        $.c.i32Const(this.setsOff);
        $.c.i32Const(32 * 6);
        $.c.arrayNewData(this.B8, 0);
        $.c.globalSet(g);
      });
      $.do($.g(g));
    });
  }
  /** character_sets::bit_at(set, b) */
  private inSet($: A, sets: X, set: X, b: X): X {
    return $.and($.shrU(this.u8($, sets, $.add($.mul(set, $.i(32)), $.shrU(b, $.i(3)))), $.and(b, $.i(7))), $.i(1));
  }
  private hexUpper($: A, n: X): X {
    return $.sel(I32, $.lt(n, $.i(10)), $.add(n, $.i(48)), $.add(n, $.i(55)));
  }

  /** ob += percent_encode(arr[from, to), set) */
  pctEncFn(): number {
    return this.fn("pctEnc", [this.obRef, this.bRef, I32, I32, I32], [], (f, $) => {
      const [O, ARR, FROM, TO, SET] = [0, 1, 2, 3, 4];
      const SETS = f.local(this.bRef);
      const I = f.local(I32);
      const B = f.local(I32);
      $.put(SETS, $.call(this.setsFn()));
      $.for(I, $.l(FROM), $.l(TO), () => {
        $.put(B, this.u8($, $.l(ARR), $.l(I)));
        $.if(this.inSet($, $.l(SETS), $.l(SET), $.l(B)), () => {
          this.push($, $.l(O), $.i(37));
          this.push($, $.l(O), this.hexUpper($, $.shrU($.l(B), $.i(4))));
          this.push($, $.l(O), this.hexUpper($, $.and($.l(B), $.i(15))));
        }, () => this.push($, $.l(O), $.l(B)));
      });
    });
  }
  private pctEnc($: A, ob: X, arr: X, from: X, to: X, set: number | X): void {
    $.run(this.pctEncFn(), ob, arr, from, to, typeof set === "number" ? $.i(set) : set);
  }

  private isHexDigit($: A, b: X): X {
    return $.or($.both($.ge(b, $.i(48)), $.le(b, $.i(57))), $.both($.ge($.or(b, $.i(0x20)), $.i(97)), $.le($.or(b, $.i(0x20)), $.i(102))));
  }
  private hexVal($: A, b: X): X {
    return $.sel(I32, $.le(b, $.i(57)), $.sub(b, $.i(48)), $.sub($.or(b, $.i(0x20)), $.i(87)));
  }

  /** unicode::percent_decode(arr[from, to)) -> bytes */
  pctDecodeFn(): number {
    return this.fn("pctDecode", [this.bRef, I32, I32], [this.bRef], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const O = f.local(this.obRef);
      const I = f.local(I32);
      const B = f.local(I32);
      $.put(O, this.obNew($));
      $.put(I, $.l(FROM));
      $.while($.lt($.l(I), $.l(TO)), () => {
        $.put(B, this.u8($, $.l(ARR), $.l(I)));
        $.if(
          $.andThen(
            $.both($.eq($.l(B), $.i(37)), $.ge($.sub($.sub($.l(TO), $.l(I)), $.i(1)), $.i(2))),
            $.both(this.isHexDigit($, this.u8($, $.l(ARR), $.add($.l(I), $.i(1)))), this.isHexDigit($, this.u8($, $.l(ARR), $.add($.l(I), $.i(2))))),
          ),
          () => {
            this.push($, $.l(O), $.add($.mul(this.hexVal($, this.u8($, $.l(ARR), $.add($.l(I), $.i(1)))), $.i(16)), this.hexVal($, this.u8($, $.l(ARR), $.add($.l(I), $.i(2))))));
            $.put(I, $.add($.l(I), $.i(3)));
          },
          () => {
            this.push($, $.l(O), $.l(B));
            $.put(I, $.add($.l(I), $.i(1)));
          },
        );
      });
      $.do($.call(this.obToBytesFn(), $.l(O)));
    });
  }

  /* ── small checkers ───────────────────────────────────────────────── */

  private isAlpha($: A, b: X): X {
    return $.both($.ge($.or(b, $.i(0x20)), $.i(97)), $.le($.or(b, $.i(0x20)), $.i(122)));
  }
  private isDigit($: A, b: X): X {
    return $.both($.ge(b, $.i(48)), $.le(b, $.i(57)));
  }
  private isSlash($: A, b: X): X {
    return $.either($.eq(b, $.i(47)), $.eq(b, $.i(92)));
  }
  /** is_alnum_plus */
  private isAlnumPlus($: A, b: X): X {
    return $.either($.either(this.isAlpha($, b), this.isDigit($, b)), $.either($.eq(b, $.i(43)), $.either($.eq(b, $.i(45)), $.eq(b, $.i(46)))));
  }
  /** One byte in a list. */
  private isAny($: A, b: X, chars: string): X {
    let x = $.eq(b, $.i(chars.charCodeAt(0)));
    for (let i = 1; i < chars.length; i++) x = $.either(x, $.eq(b, $.i(chars.charCodeAt(i))));
    return x;
  }
  private forbiddenHost($: A, b: X): X {
    return this.isAny($, b, "\x00\t\n\r #/:<>?@[\\]^|");
  }
  private forbiddenDomain($: A, b: X): X {
    return $.either($.either(this.forbiddenHost($, b), $.eq(b, $.i(37))), $.either($.le(b, $.i(32)), $.ge(b, $.i(127))));
  }

  /** checkers::is_windows_drive_letter(arr[from, to)) */
  winDriveFn(): number {
    return this.fn("winDrive", [this.bRef, I32, I32], [I32], (_f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const at = (k: number): X => this.u8($, $.l(ARR), $.add($.l(FROM), $.i(k)));
      $.if($.lt($.sub($.l(TO), $.l(FROM)), $.i(2)), () => $.ret($.i(0)));
      $.if($.not($.both(this.isAlpha($, at(0)), $.either($.eq(at(1), $.i(58)), $.eq(at(1), $.i(124))))), () => $.ret($.i(0)));
      $.if($.eq($.sub($.l(TO), $.l(FROM)), $.i(2)), () => $.ret($.i(1)));
      $.do(this.isAny($, at(2), "/\\?#"));
    });
  }

  /* ── the parser (ada::parser::parse_url_impl, base-less) ──────────── */

  /** Drop every TAB / LF / CR (remove_ascii_tab_or_newline). */
  stripTabsFn(): number {
    return this.fn("stripTabs", [this.bRef], [this.bRef], (f, $) => {
      const IN = 0;
      const O = f.local(this.obRef);
      const I = f.local(I32);
      const B = f.local(I32);
      $.put(O, this.obNew($));
      $.for(I, $.i(0), $.alen($.l(IN)), () => {
        $.put(B, this.u8($, $.l(IN), $.l(I)));
        $.if($.not(this.isAny($, $.l(B), "\t\n\r")), () => this.push($, $.l(O), $.l(B)));
      });
      $.do($.call(this.obToBytesFn(), $.l(O)));
    });
  }

  /** scheme::get_scheme_type over lowercase arr[from, to). */
  schemeTypeFn(): number {
    return this.fn("schemeType", [this.bRef, I32, I32], [I32], (_f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      for (const [name, t] of SCHEMES) {
        let cond = $.eq($.sub($.l(TO), $.l(FROM)), $.i(name.length));
        const chars: X[] = [];
        for (let k = 0; k < name.length; k++) chars.push($.eq(this.u8($, $.l(ARR), $.add($.l(FROM), $.i(k))), $.i(name.charCodeAt(k))));
        let all = chars[0]!;
        for (let k = 1; k < chars.length; k++) all = $.both(all, chars[k]!);
        cond = $.andThen(cond, all);
        $.if(cond, () => $.ret($.i(t)));
      }
      $.do($.i(T_NOT_SPECIAL));
    });
  }

  /** The AUTHORITY state's userinfo loop: answers the host's start, or -1
   * (an '@' followed by an empty host). */
  authorityFn(): number {
    return this.fn("authority", [this.bRef, I32, I32, I32, this.obRef, this.obRef], [I32], (f, $) => {
      const [IN, P0, E, SPECIAL, USER, PASS] = [0, 1, 2, 3, 4, 5];
      const P = f.local(I32);
      const L = f.local(I32);
      const C = f.local(I32);
      const AT = f.local(I32);
      const PW = f.local(I32);
      $.put(P, $.l(P0));
      $.while($.i(1), () => {
        $.put(L, $.call(this.authDelimFn(), $.l(IN), $.l(P), $.l(E), $.l(SPECIAL)));
        $.if($.andThen($.ne($.l(L), $.l(E)), $.eq(this.u8($, $.l(IN), $.l(L)), $.i(64))), () => {
          $.if($.l(AT), () => {
            $.if($.l(PW), () => this.pushLit($, $.l(PASS), "%40"), () => this.pushLit($, $.l(USER), "%40"));
          });
          $.put(AT, $.i(1));
          $.if($.not($.l(PW)), () => {
            $.put(C, this.find($, $.l(IN), $.l(P), $.l(L), 58));
            $.put(PW, $.lt($.l(C), $.l(L)));
            $.if($.not($.l(PW)), () => this.pctEnc($, $.l(USER), $.l(IN), $.l(P), $.l(L), SET_USERINFO), () => {
              this.pctEnc($, $.l(USER), $.l(IN), $.l(P), $.l(C), SET_USERINFO);
              this.pctEnc($, $.l(PASS), $.l(IN), $.add($.l(C), $.i(1)), $.l(L), SET_USERINFO);
            });
          }, () => this.pctEnc($, $.l(PASS), $.l(IN), $.l(P), $.l(L), SET_USERINFO));
          $.put(P, $.add($.l(L), $.i(1)));
        }, () => {
          $.if($.both($.l(AT), $.eq($.l(L), $.l(P))), () => $.ret($.i(-1)));
          $.ret($.l(P));
        });
      });
      $.do($.i(-1));
    });
  }

  /** find_authority_delimiter(_special): the first of @ / ? (and \ when
   * special) in [from, to), else `to`. */
  authDelimFn(): number {
    return this.fn("authDelim", [this.bRef, I32, I32, I32], [I32], (f, $) => {
      const [IN, FROM, TO, SPECIAL] = [0, 1, 2, 3];
      const I = f.local(I32);
      const B = f.local(I32);
      $.for(I, $.l(FROM), $.l(TO), () => {
        $.put(B, this.u8($, $.l(IN), $.l(I)));
        $.if($.either(this.isAny($, $.l(B), "@/?"), $.both($.l(SPECIAL), $.eq($.l(B), $.i(92)))), () => $.ret($.l(I)));
      });
      $.do($.l(TO));
    });
  }

  /** helpers::get_host_delimiter_location: the end of the host in
   * [from, to); the byte there is ':' exactly when found_colon. */
  hostDelimFn(): number {
    return this.fn("hostDelim", [this.bRef, I32, I32, I32], [I32], (f, $) => {
      const [IN, FROM, TO, SPECIAL] = [0, 1, 2, 3];
      const I = f.local(I32);
      const B = f.local(I32);
      const J = f.local(I32);
      $.put(I, $.l(FROM));
      $.while($.lt($.l(I), $.l(TO)), () => {
        $.put(B, this.u8($, $.l(IN), $.l(I)));
        $.if($.eq($.l(B), $.i(91)), () => {
          $.put(J, this.find($, $.l(IN), $.l(I), $.l(TO), 93));
          $.if($.eq($.l(J), $.l(TO)), () => $.ret($.l(TO)));
          $.put(I, $.l(J));
        }, () => {
          $.if($.either(this.isAny($, $.l(B), ":/?"), $.both($.l(SPECIAL), $.eq($.l(B), $.i(92)))), () => $.ret($.l(I)));
          $.put(I, $.add($.l(I), $.i(1)));
        });
      });
      $.do($.l(TO));
    });
  }

  /** ASCII-lowercase copy of arr[from, to). */
  lowerCopyFn(): number {
    return this.fn("lowerCopy", [this.bRef, I32, I32], [this.bRef], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const R = f.local(this.bRef);
      const I = f.local(I32);
      const B = f.local(I32);
      $.put(R, $.anew(this.B8, $.sub($.l(TO), $.l(FROM))));
      $.for(I, $.l(FROM), $.l(TO), () => {
        $.put(B, this.u8($, $.l(ARR), $.l(I)));
        $.if($.both($.ge($.l(B), $.i(65)), $.le($.l(B), $.i(90))), () => $.put(B, $.add($.l(B), $.i(32))));
        $.aset(this.B8, $.l(R), $.sub($.l(I), $.l(FROM)), $.l(B));
      });
      $.do($.l(R));
    });
  }

  /** checkers::try_parse_ipv4_fast succeeded (pure dotted decimal). */
  ipv4FastFn(): number {
    return this.fn("ipv4Fast", [this.bRef, I32, I32], [I32], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const P = f.local(I32);
      const K = f.local(I32);
      const V = f.local(I32);
      const at = (): X => this.u8($, $.l(ARR), $.l(P));
      $.put(P, $.l(FROM));
      $.for(K, $.i(0), $.i(4), () => {
        $.if($.eq($.l(P), $.l(TO)), () => $.ret($.i(0)));
        $.if($.not(this.isDigit($, at())), () => $.ret($.i(0)));
        $.put(V, $.sub(at(), $.i(48)));
        $.put(P, $.add($.l(P), $.i(1)));
        $.if($.andThen($.lt($.l(P), $.l(TO)), this.isDigit($, at())), () => {
          $.if($.not($.l(V)), () => $.ret($.i(0)));
          $.put(V, $.add($.mul($.l(V), $.i(10)), $.sub(at(), $.i(48))));
          $.put(P, $.add($.l(P), $.i(1)));
          $.if($.andThen($.lt($.l(P), $.l(TO)), this.isDigit($, at())), () => {
            $.put(V, $.add($.mul($.l(V), $.i(10)), $.sub(at(), $.i(48))));
            $.put(P, $.add($.l(P), $.i(1)));
            $.if($.gt($.l(V), $.i(255)), () => $.ret($.i(0)));
          });
        });
        $.if($.lt($.l(K), $.i(3)), () => {
          $.if($.orElse($.eq($.l(P), $.l(TO)), $.ne(at(), $.i(46))), () => $.ret($.i(0)));
          $.put(P, $.add($.l(P), $.i(1)));
        });
      });
      $.if($.ne($.l(P), $.l(TO)), () => {
        $.if($.both($.eq($.l(P), $.sub($.l(TO), $.i(1))), $.eq(at(), $.i(46))), () => $.ret($.i(1)));
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** checkers::is_ipv4 ("ends in a number") over lowercase arr[from, to). */
  isIpv4Fn(): number {
    return this.fn("isIpv4", [this.bRef, I32, I32], [I32], (f, $) => {
      const [ARR, FROM, TO0] = [0, 1, 2];
      const TO = f.local(I32);
      const L = f.local(I32);
      const D = f.local(I32);
      const I = f.local(I32);
      const at = (i: X): X => this.u8($, $.l(ARR), i);
      $.put(TO, $.l(TO0));
      $.if($.eq($.l(TO), $.l(FROM)), () => $.ret($.i(0)));
      $.if($.eq(at($.sub($.l(TO), $.i(1))), $.i(46)), () => {
        $.put(TO, $.sub($.l(TO), $.i(1)));
        $.if($.eq($.l(TO), $.l(FROM)), () => $.ret($.i(0)));
      });
      $.put(L, at($.sub($.l(TO), $.i(1))));
      $.if($.not($.either(this.isDigit($, $.l(L)), $.either($.both($.ge($.l(L), $.i(97)), $.le($.l(L), $.i(102))), $.eq($.l(L), $.i(120))))), () => $.ret($.i(0)));
      // the last label
      $.put(D, $.l(FROM));
      $.for(I, $.l(FROM), $.l(TO), () => $.if($.eq(at($.l(I)), $.i(46)), () => $.put(D, $.add($.l(I), $.i(1)))));
      $.put(L, $.i(1));
      $.for(I, $.l(D), $.l(TO), () => $.if($.not(this.isDigit($, at($.l(I)))), () => $.put(L, $.i(0))));
      $.if($.l(L), () => $.ret($.i(1)));
      $.if($.eq($.sub($.l(TO), $.l(D)), $.i(1)), () => $.ret($.i(0)));
      $.if($.not($.both($.eq(at($.l(D)), $.i(48)), $.eq(at($.add($.l(D), $.i(1))), $.i(120)))), () => $.ret($.i(0)));
      $.if($.eq($.sub($.l(TO), $.l(D)), $.i(2)), () => $.ret($.i(1)));
      $.for(I, $.add($.l(D), $.i(2)), $.l(TO), () => {
        $.if($.not($.either(this.isDigit($, at($.l(I))), $.both($.ge(at($.l(I)), $.i(97)), $.le(at($.l(I)), $.i(102))))), () => $.ret($.i(0)));
      });
      $.do($.i(1));
    });
  }

  private div($: A, a: X, b: X): X {
    return () => {
      a();
      b();
      $.c.i32DivS();
    };
  }
  private rem($: A, a: X, b: X): X {
    return () => {
      a();
      b();
      $.c.i32RemS();
    };
  }

  /** ob += decimal(v), 0 <= v < 2^31 */
  itoaFn(): number {
    return this.fn("itoa", [this.obRef, I32], [], (f, $) => {
      const [O, V] = [0, 1];
      const D = f.local(I32);
      $.put(D, $.i(1));
      $.while($.le($.l(D), this.div($, $.l(V), $.i(10))), () => $.put(D, $.mul($.l(D), $.i(10))));
      $.while($.gt($.l(D), $.i(0)), () => {
        this.push($, $.l(O), $.add($.i(48), this.div($, $.l(V), $.l(D))));
        $.put(V, this.rem($, $.l(V), $.l(D)));
        $.put(D, this.div($, $.l(D), $.i(10)));
      });
    });
  }

  /** ob += lowercase hex(v), no leading zeros (std::to_chars base 16) */
  hexLowerFn(): number {
    return this.fn("hexLower", [this.obRef, I32], [], (f, $) => {
      const [O, V] = [0, 1];
      const S = f.local(I32);
      const N = f.local(I32);
      $.put(S, $.i(12));
      $.while($.both($.gt($.l(S), $.i(0)), $.not($.and($.shrU($.l(V), $.l(S)), $.i(15)))), () => $.put(S, $.sub($.l(S), $.i(4))));
      $.while($.ge($.l(S), $.i(0)), () => {
        $.put(N, $.and($.shrU($.l(V), $.l(S)), $.i(15)));
        this.push($, $.l(O), $.sel(I32, $.lt($.l(N), $.i(10)), $.add($.l(N), $.i(48)), $.add($.l(N), $.i(87))));
        $.put(S, $.sub($.l(S), $.i(4)));
      });
    });
  }

  /** std::from_chars<uint32_t>(arr + from, arr + to, base): (end << 32) |
   * value, -1 for no digits, -2 for out of range (every digit is
   * consumed either way, as from_chars does). */
  fromCharsFn(): number {
    return this.fn("fromChars", [this.bRef, I32, I32, I32], [I64], (f, $) => {
      const [ARR, FROM, TO, BASE] = [0, 1, 2, 3];
      const P = f.local(I32);
      const V = f.local(I64);
      const OVF = f.local(I32);
      const DV = f.local(I32);
      const c = f.c;
      const digit = (b: X): X =>
        $.sel(I32, this.isDigit($, b), $.sub(b, $.i(48)), $.sel(I32, this.isAlpha($, b), $.sub($.or(b, $.i(0x20)), $.i(87)), $.i(99)));
      $.put(P, $.l(FROM));
      $.while($.andThen($.lt($.l(P), $.l(TO)), $.lt($.tee(DV, digit(this.u8($, $.l(ARR), $.l(P)))), $.l(BASE))), () => {
        c.localGet(V);
        c.localGet(BASE);
        c.i64ExtendI32U();
        c.i64Mul();
        c.localGet(DV);
        c.i64ExtendI32U();
        c.i64Add();
        c.localSet(V);
        $.if($.raw((cc) => {
          cc.localGet(V);
          cc.i64Const(0xffffffffn);
          cc.i64GtU();
        }), () => {
          $.put(OVF, $.i(1));
          $.put(V, $.j(0n));
        });
        $.put(P, $.add($.l(P), $.i(1)));
      });
      $.if($.eq($.l(P), $.l(FROM)), () => $.ret($.j(-1n)));
      $.if($.l(OVF), () => $.ret($.j(-2n)));
      $.do($.raw((cc) => {
        cc.localGet(P);
        cc.i64ExtendI32U();
        cc.i64Const(32n);
        cc.i64Shl();
        cc.localGet(V);
        cc.i64Or();
      }));
    });
  }

  /** url::parse_ipv4 over lowercase arr[from, to): the host, or null. */
  parseIpv4Fn(): number {
    return this.fn("parseIpv4", [this.bRef, I32, I32], [this.sRef], (f, $) => {
      const [ARR, FROM, TO0] = [0, 1, 2];
      const TO = f.local(I32);
      const P = f.local(I32);
      const CNT = f.local(I32);
      const PURE = f.local(I32);
      const IP = f.local(I64);
      const SEG = f.local(I64);
      const R = f.local(I64);
      const BASE = f.local(I32);
      const ST = f.local(I32);
      const FIN = f.local(I32);
      const HEX = f.local(I32);
      const SH = f.local(I32);
      const O = f.local(this.obRef);
      const K = f.local(I32);
      const at = (i: X): X => this.u8($, $.l(ARR), i);
      const i64 = (body: (c: Code) => void): X => $.raw(body);
      $.put(TO, $.l(TO0));
      $.if($.eq(at($.sub($.l(TO), $.i(1))), $.i(46)), () => $.put(TO, $.sub($.l(TO), $.i(1))));
      $.put(P, $.l(FROM));
      $.while($.both($.not($.l(FIN)), $.both($.lt($.l(CNT), $.i(4)), $.lt($.l(P), $.l(TO)))), () => {
        $.put(HEX, $.andThen($.ge($.sub($.l(TO), $.l(P)), $.i(2)), $.both($.eq(at($.l(P)), $.i(48)), $.eq($.or(at($.add($.l(P), $.i(1))), $.i(0x20)), $.i(120)))));
        $.if($.andThen($.l(HEX), $.orElse($.eq($.sub($.l(TO), $.l(P)), $.i(2)), $.eq(at($.add($.l(P), $.i(2))), $.i(46)))), () => {
          $.put(SEG, $.j(0n));
          $.put(P, $.add($.l(P), $.i(2)));
        }, () => {
          $.if($.l(HEX), () => {
            $.put(BASE, $.i(16));
            $.put(ST, $.add($.l(P), $.i(2)));
          }, () => {
            $.if($.andThen($.ge($.sub($.l(TO), $.l(P)), $.i(2)), $.both($.eq(at($.l(P)), $.i(48)), this.isDigit($, at($.add($.l(P), $.i(1)))))), () => {
              $.put(BASE, $.i(8));
              $.put(ST, $.add($.l(P), $.i(1)));
            }, () => {
              $.put(PURE, $.add($.l(PURE), $.i(1)));
              $.put(BASE, $.i(10));
              $.put(ST, $.l(P));
            });
          });
          $.put(R, $.call(this.fromCharsFn(), $.l(ARR), $.l(ST), $.l(TO), $.l(BASE)));
          $.if(i64((c) => {
            c.localGet(R);
            c.i64Const(0n);
            c.i64LtS();
          }), () => $.ret($.nul(this.S)));
          $.put(SEG, i64((c) => {
            c.localGet(R);
            c.i64Const(0xffffffffn);
            c.i64And();
          }));
          $.put(P, i64((c) => {
            c.localGet(R);
            c.i64Const(32n);
            c.i64ShrU();
            c.i32WrapI64();
          }));
        });
        $.if($.eq($.l(P), $.l(TO)), () => {
          $.put(SH, $.sub($.i(32), $.mul($.l(CNT), $.i(8))));
          // segment >= 2^(32 - 8 * count)
          $.if(i64((c) => {
            c.localGet(SEG);
            c.i64Const(1n);
            c.localGet(SH);
            c.i64ExtendI32U();
            c.i64Shl();
            c.i64GeU();
          }), () => $.ret($.nul(this.S)));
          $.put(IP, i64((c) => {
            c.localGet(IP);
            c.localGet(SH);
            c.i64ExtendI32U();
            c.i64Shl();
            c.localGet(SEG);
            c.i64Or();
          }));
          $.put(FIN, $.i(1));
        }, () => {
          $.if($.either(i64((c) => {
            c.localGet(SEG);
            c.i64Const(255n);
            c.i64GtU();
          }), $.ne(at($.l(P)), $.i(46))), () => $.ret($.nul(this.S)));
          $.put(IP, i64((c) => {
            c.localGet(IP);
            c.i64Const(8n);
            c.i64Shl();
            c.localGet(SEG);
            c.i64Or();
          }));
          $.put(P, $.add($.l(P), $.i(1)));
          $.put(CNT, $.add($.l(CNT), $.i(1)));
        });
      });
      $.if($.both($.not($.l(FIN)), $.either($.ne($.l(CNT), $.i(4)), $.ne($.l(P), $.l(TO)))), () => $.ret($.nul(this.S)));
      $.if($.eq($.l(PURE), $.i(4)), () => $.ret($.call(this.rangeStrFn(), $.l(ARR), $.l(FROM), $.l(TO))));
      $.put(O, this.obNew($));
      for (const shift of [24, 16, 8, 0]) {
        $.put(K, i64((c) => {
          c.localGet(IP);
          c.i64Const(BigInt(shift));
          c.i64ShrU();
          c.i32WrapI64();
          c.i32Const(255);
          c.i32And();
        }));
        $.run(this.itoaFn(), $.l(O), $.l(K));
        if (shift !== 0) this.push($, $.l(O), $.i(46));
      }
      $.do(this.obStr($, $.l(O)));
    });
  }

  /** url::parse_ipv6 over arr[from, to) (the brackets stripped): the
   * serialized "[...]" host, or null. */
  parseIpv6Fn(): number {
    return this.fn("parseIpv6", [this.bRef, I32, I32], [this.sRef], (f, $) => {
      const [IN, F, T] = [0, 1, 2];
      const AD = f.local(this.ref(this.I32A));
      const PI = f.local(I32);
      const COMP = f.local(I32);
      const P = f.local(I32);
      const V = f.local(I32);
      const LEN = f.local(I32);
      const NS = f.local(I32);
      const PIECE = f.local(I32);
      const N = f.local(I32);
      const BRK = f.local(I32);
      const SW = f.local(I32);
      const TMP = f.local(I32);
      const at = (i: X): X => this.u8($, $.l(IN), i);
      const ad = (i: X): X => $.aget(this.I32A, $.l(AD), i);
      const nul = (): void => $.ret($.nul(this.S));
      $.if($.eq($.l(F), $.l(T)), nul);
      $.put(AD, $.anew(this.I32A, $.i(8)));
      $.put(COMP, $.i(-1));
      $.put(P, $.l(F));
      $.if($.eq(at($.l(F)), $.i(58)), () => {
        $.if($.orElse($.eq($.sub($.l(T), $.l(F)), $.i(1)), $.ne(at($.add($.l(F), $.i(1))), $.i(58))), nul);
        $.put(P, $.add($.l(F), $.i(2)));
        $.put(PI, $.i(1));
        $.put(COMP, $.i(1));
      });
      $.while($.both($.ne($.l(P), $.l(T)), $.not($.l(BRK))), () => {
        $.if($.eq($.l(PI), $.i(8)), nul);
        $.if($.eq(at($.l(P)), $.i(58)), () => {
          $.if($.ge($.l(COMP), $.i(0)), nul);
          $.put(P, $.add($.l(P), $.i(1)));
          $.put(PI, $.add($.l(PI), $.i(1)));
          $.put(COMP, $.l(PI));
        }, () => {
          $.put(V, $.i(0));
          $.put(LEN, $.i(0));
          $.while($.andThen($.both($.lt($.l(LEN), $.i(4)), $.ne($.l(P), $.l(T))), this.isHexDigit($, at($.l(P)))), () => {
            $.put(V, $.add($.mul($.l(V), $.i(16)), this.hexVal($, at($.l(P)))));
            $.put(P, $.add($.l(P), $.i(1)));
            $.put(LEN, $.add($.l(LEN), $.i(1)));
          });
          $.if($.andThen($.ne($.l(P), $.l(T)), $.eq(at($.l(P)), $.i(46))), () => {
            $.if($.not($.l(LEN)), nul);
            $.put(P, $.sub($.l(P), $.l(LEN)));
            $.if($.gt($.l(PI), $.i(6)), nul);
            $.put(NS, $.i(0));
            $.while($.ne($.l(P), $.l(T)), () => {
              $.put(PIECE, $.i(-1));
              $.if($.gt($.l(NS), $.i(0)), () => {
                $.if($.both($.eq(at($.l(P)), $.i(46)), $.lt($.l(NS), $.i(4))), () => $.put(P, $.add($.l(P), $.i(1))), nul);
              });
              $.if($.orElse($.eq($.l(P), $.l(T)), $.not(this.isDigit($, at($.l(P))))), nul);
              $.while($.andThen($.ne($.l(P), $.l(T)), this.isDigit($, at($.l(P)))), () => {
                $.put(N, $.sub(at($.l(P)), $.i(48)));
                $.if($.eq($.l(PIECE), $.i(-1)), () => $.put(PIECE, $.l(N)), () => {
                  $.if($.eq($.l(PIECE), $.i(0)), nul);
                  $.put(PIECE, $.add($.mul($.l(PIECE), $.i(10)), $.l(N)));
                });
                $.if($.gt($.l(PIECE), $.i(255)), nul);
                $.put(P, $.add($.l(P), $.i(1)));
              });
              $.aset(this.I32A, $.l(AD), $.l(PI), $.and($.add($.mul(ad($.l(PI)), $.i(256)), $.l(PIECE)), $.i(0xffff)));
              $.put(NS, $.add($.l(NS), $.i(1)));
              $.if($.either($.eq($.l(NS), $.i(2)), $.eq($.l(NS), $.i(4))), () => $.put(PI, $.add($.l(PI), $.i(1))));
            });
            $.if($.ne($.l(NS), $.i(4)), nul);
            $.put(BRK, $.i(1));
          }, () => {
            $.if($.andThen($.ne($.l(P), $.l(T)), $.eq(at($.l(P)), $.i(58))), () => {
              $.put(P, $.add($.l(P), $.i(1)));
              $.if($.eq($.l(P), $.l(T)), nul);
            }, () => {
              $.if($.ne($.l(P), $.l(T)), nul);
            });
            $.aset(this.I32A, $.l(AD), $.l(PI), $.l(V));
            $.put(PI, $.add($.l(PI), $.i(1)));
          });
        });
      });
      $.if($.ge($.l(COMP), $.i(0)), () => {
        $.put(SW, $.sub($.l(PI), $.l(COMP)));
        $.put(PI, $.i(7));
        $.while($.both($.ne($.l(PI), $.i(0)), $.gt($.l(SW), $.i(0))), () => {
          $.put(TMP, ad($.l(PI)));
          $.aset(this.I32A, $.l(AD), $.l(PI), ad($.sub($.add($.l(COMP), $.l(SW)), $.i(1))));
          $.aset(this.I32A, $.l(AD), $.sub($.add($.l(COMP), $.l(SW)), $.i(1)), $.l(TMP));
          $.put(PI, $.sub($.l(PI), $.i(1)));
          $.put(SW, $.sub($.l(SW), $.i(1)));
        });
      }, () => {
        $.if($.ne($.l(PI), $.i(8)), nul);
      });
      $.do($.call(this.ipv6SerFn(), $.l(AD)));
    });
  }

  /** serializers::ipv6 */
  ipv6SerFn(): number {
    return this.fn("ipv6Ser", [this.ref(this.I32A)], [this.sRef], (f, $) => {
      const AD = 0;
      const CL = f.local(I32);
      const CP = f.local(I32);
      const I = f.local(I32);
      const NX = f.local(I32);
      const O = f.local(this.obRef);
      const PI = f.local(I32);
      const DONE = f.local(I32);
      const ad = (i: X): X => $.aget(this.I32A, $.l(AD), i);
      // find_longest_sequence_of_ipv6_pieces
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.i(8)), () => {
        $.if($.not(ad($.l(I))), () => {
          $.put(NX, $.add($.l(I), $.i(1)));
          $.while($.andThen($.ne($.l(NX), $.i(8)), $.not(ad($.l(NX)))), () => $.put(NX, $.add($.l(NX), $.i(1))));
          $.if($.lt($.l(CL), $.sub($.l(NX), $.l(I))), () => {
            $.put(CL, $.sub($.l(NX), $.l(I)));
            $.put(CP, $.l(I));
            $.if($.eq($.l(NX), $.i(8)), () => $.put(NX, $.i(16)));
            $.put(I, $.l(NX));
          });
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.if($.le($.l(CL), $.i(1)), () => {
        $.put(CL, $.i(8));
        $.put(CP, $.i(8));
      });
      $.put(O, this.obNew($));
      this.push($, $.l(O), $.i(91));
      $.while($.not($.l(DONE)), () => {
        $.if($.eq($.l(PI), $.l(CP)), () => {
          this.push($, $.l(O), $.i(58));
          $.if($.not($.l(PI)), () => this.push($, $.l(O), $.i(58)));
          $.put(PI, $.add($.l(PI), $.l(CL)));
          $.if($.eq($.l(PI), $.i(8)), () => $.put(DONE, $.i(1)));
        });
        $.if($.not($.l(DONE)), () => {
          $.run(this.hexLowerFn(), $.l(O), ad($.l(PI)));
          $.put(PI, $.add($.l(PI), $.i(1)));
          $.if($.eq($.l(PI), $.i(8)), () => $.put(DONE, $.i(1)), () => this.push($, $.l(O), $.i(58)));
        });
      });
      this.push($, $.l(O), $.i(93));
      $.do(this.obStr($, $.l(O)));
    });
  }

  /** Does arr[from, to) contain "xn-"? */
  private hasXnFn(): number {
    return this.fn("hasXn", [this.bRef, I32, I32], [I32], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const I = f.local(I32);
      const at = (i: X): X => this.u8($, $.l(ARR), i);
      $.for(I, $.l(FROM), $.sub($.l(TO), $.i(2)), () => {
        $.if($.both($.eq(at($.l(I)), $.i(120)), $.both($.eq(at($.add($.l(I), $.i(1))), $.i(110)), $.eq(at($.add($.l(I), $.i(2))), $.i(45)))), () => $.ret($.i(1)));
      });
      $.do($.i(0));
    });
  }

  private anyByteFn(name: string, pred: ($: A, b: X) => X): number {
    return this.fn(name, [this.bRef, I32, I32], [I32], (f, $) => {
      const [ARR, FROM, TO] = [0, 1, 2];
      const I = f.local(I32);
      $.for(I, $.l(FROM), $.l(TO), () => $.if(pred($, this.u8($, $.l(ARR), $.l(I))), () => $.ret($.i(1))));
      $.do($.i(0));
    });
  }

  /** url::parse_host over arr[from, to): the host, or null (failure). */
  parseHostFn(): number {
    return this.fn("parseHost", [this.bRef, I32, I32, I32], [this.sRef], (f, $) => {
      const [IN, F, T, SPECIAL] = [0, 1, 2, 3];
      const BUF = f.local(this.bRef);
      const N = f.local(I32);
      const O = f.local(this.obRef);
      const AS = f.local(this.bRef);
      const at = (i: X): X => this.u8($, $.l(IN), i);
      const forbiddenDomainAny = this.anyByteFn("anyForbiddenDomain", ($$, b) => this.forbiddenDomain($$, b));
      const forbiddenHostAny = this.anyByteFn("anyForbiddenHost", ($$, b) => this.forbiddenHost($$, b));
      $.if($.eq($.l(F), $.l(T)), () => $.ret($.nul(this.S)));
      $.if($.eq(at($.l(F)), $.i(91)), () => {
        $.if($.ne(at($.sub($.l(T), $.i(1))), $.i(93)), () => $.ret($.nul(this.S)));
        $.if($.eq($.sub($.l(T), $.l(F)), $.i(1)), () => $.ret($.nul(this.S)));
        $.ret($.call(this.parseIpv6Fn(), $.l(IN), $.add($.l(F), $.i(1)), $.sub($.l(T), $.i(1))));
      });
      $.if($.not($.l(SPECIAL)), () => {
        // parse_opaque_host
        $.if($.call(forbiddenHostAny, $.l(IN), $.l(F), $.l(T)), () => $.ret($.nul(this.S)));
        $.put(O, this.obNew($));
        this.pctEnc($, $.l(O), $.l(IN), $.l(F), $.l(T), SET_C0);
        $.ret(this.obStr($, $.l(O)));
      });
      $.if($.call(this.ipv4FastFn(), $.l(IN), $.l(F), $.l(T)), () => {
        $.ret($.call(this.rangeStrFn(), $.l(IN), $.l(F), $.sel(I32, $.eq(at($.sub($.l(T), $.i(1))), $.i(46)), $.sub($.l(T), $.i(1)), $.l(T))));
      });
      $.put(BUF, $.call(this.lowerCopyFn(), $.l(IN), $.l(F), $.l(T)));
      $.put(N, $.alen($.l(BUF)));
      $.if($.both($.not($.call(forbiddenDomainAny, $.l(BUF), $.i(0), $.l(N))), $.not($.call(this.hasXnFn(), $.l(BUF), $.i(0), $.l(N)))), () => {
        $.if($.call(this.isIpv4Fn(), $.l(BUF), $.i(0), $.l(N)), () => $.ret($.call(this.parseIpv4Fn(), $.l(BUF), $.i(0), $.l(N))));
        $.ret($.call(this.rangeStrFn(), $.l(BUF), $.i(0), $.l(N)));
      });
      // unicode::to_ascii: percent-decode, then domain to ASCII
      $.put(BUF, $.call(this.pctDecodeFn(), $.l(IN), $.l(F), $.l(T)));
      $.put(AS, $.call(this.deps.idnaToAscii(), $.l(BUF), $.i(0), $.alen($.l(BUF))));
      $.if($.isNull($.l(AS)), () => $.ret($.nul(this.S)));
      $.put(N, $.alen($.l(AS)));
      $.if($.orElse($.not($.l(N)), $.call(forbiddenDomainAny, $.l(AS), $.i(0), $.l(N))), () => $.ret($.nul(this.S)));
      $.if($.call(this.isIpv4Fn(), $.l(AS), $.i(0), $.l(N)), () => $.ret($.call(this.parseIpv4Fn(), $.l(AS), $.i(0), $.l(N))));
      $.do($.call(this.rangeStrFn(), $.l(AS), $.i(0), $.l(N)));
    });
  }

  /** helpers::shorten_path over the path buffer. */
  shortenFn(): number {
    return this.fn("shorten", [this.obRef, I32], [], (f, $) => {
      const [O, TYPE] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      const SL = f.local(I32);
      $.put(N, this.obLen($, $.l(O)));
      $.put(SL, $.i(-1));
      $.for(I, $.i(0), $.l(N), () => $.if($.eq(this.obAt($, $.l(O), $.l(I)), $.i(47)), () => $.put(SL, $.l(I))));
      $.if($.both($.eq($.l(TYPE), $.i(T_FILE)), $.gt($.l(N), $.i(0))), () => {
        // no '/' at index >= 1, and path[1..] is a normalized drive letter
        $.if($.andThen($.le($.l(SL), $.i(0)), $.andThen($.ge($.sub($.l(N), $.i(1)), $.i(2)), $.both(this.isAlpha($, this.obAt($, $.l(O), $.i(1))), $.eq(this.obAt($, $.l(O), $.i(2)), $.i(58))))), () => $.ret());
      });
      $.if($.ge($.l(SL), $.i(0)), () => $.set(this.OB, OB_N, $.l(O), $.l(SL)));
    });
  }

  /** 0 = neither, 1 = a single-dot segment, 2 = a double-dot segment
   * (unicode::is_single/double_dot_path_segment). */
  dotKindFn(): number {
    return this.fn("dotKind", [this.obRef], [I32], (_f, $) => {
      const O = 0;
      const n = this.obLen($, $.l(O));
      const at = (k: number): X => this.obAt($, $.l(O), $.i(k));
      const pe = (k: number): X => $.both($.eq(at(k), $.i(37)), $.both($.eq(at(k + 1), $.i(50)), $.eq($.or(at(k + 2), $.i(0x20)), $.i(101))));
      const dot = (k: number): X => $.eq(at(k), $.i(46));
      $.if($.eq(n, $.i(1)), () => $.ret(dot(0)));
      $.if($.eq(n, $.i(3)), () => $.ret(pe(0)));
      $.if($.eq(n, $.i(2)), () => $.ret($.mul($.both(dot(0), dot(1)), $.i(2))));
      $.if($.eq(n, $.i(4)), () => $.ret($.mul($.either($.both(dot(0), pe(1)), $.both(pe(0), dot(3))), $.i(2))));
      $.if($.eq(n, $.i(6)), () => $.ret($.mul($.both(pe(0), pe(3)), $.i(2))));
      $.do($.i(0));
    });
  }

  /** helpers::parse_prepared_path (its general case) over in[from, to),
   * appending to the path buffer. */
  parsePathFn(): number {
    return this.fn("parsePath", [this.bRef, I32, I32, I32, this.obRef], [], (f, $) => {
      const [IN, F, T, TYPE, PATH] = [0, 1, 2, 3, 4];
      const P = f.local(I32);
      const L = f.local(I32);
      const B = f.local(I32);
      const SEG = f.local(this.obRef);
      const K = f.local(I32);
      const LAST = f.local(I32);
      const SEGB = f.local(this.bRef);
      $.put(P, $.l(F));
      $.while($.i(1), () => {
        // find '/' (or '\\' too when special)
        $.put(L, $.l(P));
        $.while($.andThen($.lt($.l(L), $.l(T)), $.not($.either($.eq($.tee(B, this.u8($, $.l(IN), $.l(L))), $.i(47)), $.both($.ne($.l(TYPE), $.i(T_NOT_SPECIAL)), $.eq($.l(B), $.i(92)))))), () => $.put(L, $.add($.l(L), $.i(1))));
        $.put(LAST, $.eq($.l(L), $.l(T)));
        $.put(SEG, this.obNew($));
        this.pctEnc($, $.l(SEG), $.l(IN), $.l(P), $.l(L), SET_PATH);
        $.put(K, $.call(this.dotKindFn(), $.l(SEG)));
        $.if($.eq($.l(K), $.i(2)), () => {
          $.run(this.shortenFn(), $.l(PATH), $.l(TYPE));
          $.if($.l(LAST), () => this.push($, $.l(PATH), $.i(47)));
        }, () => {
          $.if($.eq($.l(K), $.i(1)), () => {
            $.if($.l(LAST), () => this.push($, $.l(PATH), $.i(47)));
          }, () => {
            $.put(SEGB, $.get(this.OB, OB_A, $.l(SEG)));
            $.if($.andThen($.both($.eq($.l(TYPE), $.i(T_FILE)), $.not(this.obLen($, $.l(PATH)))), $.call(this.winDriveFn(), $.l(SEGB), $.i(0), this.obLen($, $.l(SEG)))), () => {
              this.push($, $.l(PATH), $.i(47));
              this.push($, $.l(PATH), this.u8($, $.l(SEGB), $.i(0)));
              this.push($, $.l(PATH), $.i(58));
              $.run(this.obAppendFn(), $.l(PATH), $.l(SEGB), $.i(2), this.obLen($, $.l(SEG)));
            }, () => {
              this.push($, $.l(PATH), $.i(47));
              $.run(this.obAppendFn(), $.l(PATH), $.l(SEGB), $.i(0), this.obLen($, $.l(SEG)));
            });
          });
        });
        $.if($.l(LAST), () => $.ret());
        $.put(P, $.add($.l(L), $.i(1)));
      });
    });
  }

  /** ada::parser::parse_url_impl over UTF-8 input (no base): the URL, or
   * null. */
  parseFn(): number {
    return this.fn("parse", [this.bRef], [this.urlRef()], (f, $) => this.parseBody(f, $, false));
  }

  /** parse_url_impl against a non-null base URL (already parsed — Node
   * parses the base first and throws on it before the input is read). */
  parseBaseFn(): number {
    return this.fn("parseBase", [this.bRef, this.urlRef()], [this.urlRef()], (f, $) => this.parseBody(f, $, true));
  }

  /** ob holding an ASCII string's bytes (a base component cloned into the
   * buffer the parser goes on appending to). */
  obFromStrFn(): number {
    return this.fn("obFromStr", [this.sRef], [this.obRef], (f, $) => {
      const O = f.local(this.obRef);
      $.put(O, this.obNew($));
      $.run(this.obAppendStrFn(), $.l(O), $.l(0));
      $.do($.l(O));
    });
  }

  /** The parser body; `withBase` adds param 1 (the base $url) and the
   * states only a base reaches. With `withBase` false the emitted code is
   * the base-less parser exactly. */
  private parseBody(f: Fn, $: A, withBase: boolean): void {
    {
      const IN0 = 0;
      const IN = f.local(this.bRef);
      const S0 = f.local(I32);
      const E = f.local(I32);
      const H = f.local(I32);
      const FF = f.local(I32);
      const FT = f.local(I32);
      const P = f.local(I32);
      const ST = f.local(I32);
      const TYPE = f.local(I32);
      const SP = f.local(I32);
      const SCH = f.local(this.sRef);
      const USER = f.local(this.obRef);
      const PASS = f.local(this.obRef);
      const HOST = f.local(this.sRef);
      const PORT = f.local(I32);
      const PATH = f.local(this.obRef);
      const OPQ = f.local(I32);
      const QUERY = f.local(this.sRef);
      const FRAG = f.local(this.sRef);
      const L = f.local(I32);
      const Q = f.local(I32);
      const LB = f.local(this.bRef);
      const D = f.local(I32);
      const V = f.local(I32);
      const OVF = f.local(I32);
      const DP = f.local(I32);
      const O = f.local(this.obRef);
      const HS = f.local(this.sRef);
      // base-only locals (declared after every base-less one)
      const BASE = 1;
      const BK = withBase ? f.local(I32) : -1;
      const BI = withBase ? f.local(I32) : -1;
      const BP = withBase ? f.local(this.sRef) : -1;
      const bg = (i: number): X => $.get(this.urlType(), i, $.l(BASE));
      const obFrom = (s: X): X => $.call(this.obFromStrFn(), s);
      const at = (i: X): X => this.u8($, $.l(IN), i);
      const fail = (): void => $.ret($.nul(this.urlType()));
      const is = (s: number): X => $.eq($.l(ST), $.i(s));
      const go = (s: number): void => $.put(ST, $.i(s));
      const inc = (): void => $.put(P, $.add($.l(P), $.i(1)));
      const notEof = (): X => $.ne($.l(P), $.l(E));
      const cIs = (b: number): X => $.andThen(notEof(), $.eq(at($.l(P)), $.i(b)));
      const cSlash = (): X => $.andThen(notEof(), this.isSlash($, at($.l(P))));
      const parseHost = (from: X, to: X): X => $.call(this.parseHostFn(), $.l(IN), from, to, $.l(SP));
      const empty = (): X => $.anew(this.S, $.i(0));

      $.put(IN, $.call(this.stripTabsFn(), $.l(IN0)));
      $.put(E, $.alen($.l(IN)));
      $.while($.andThen($.lt($.l(S0), $.l(E)), $.le(at($.l(S0)), $.i(32))), () => $.put(S0, $.add($.l(S0), $.i(1))));
      $.while($.andThen($.gt($.l(E), $.l(S0)), $.le(at($.sub($.l(E), $.i(1))), $.i(32))), () => $.put(E, $.sub($.l(E), $.i(1))));
      // prune_hash
      $.put(FF, $.i(-1));
      $.put(H, this.find($, $.l(IN), $.l(S0), $.l(E), 35));
      $.if($.lt($.l(H), $.l(E)), () => {
        $.put(FF, $.add($.l(H), $.i(1)));
        $.put(FT, $.l(E));
        $.put(E, $.l(H));
      });
      // SCHEME_START / SCHEME (NO_SCHEME with no base is failure)
      $.put(P, $.l(S0));
      if (!withBase) {
        $.if($.not($.andThen(notEof(), this.isAlpha($, at($.l(P))))), fail);
        inc();
        $.while($.andThen(notEof(), this.isAlnumPlus($, at($.l(P)))), inc);
        $.if($.not(cIs(58)), fail);
        $.put(LB, $.call(this.lowerCopyFn(), $.l(IN), $.l(S0), $.l(P)));
        $.put(TYPE, $.call(this.schemeTypeFn(), $.l(LB), $.i(0), $.alen($.l(LB))));
        $.put(SP, $.ne($.l(TYPE), $.i(T_NOT_SPECIAL)));
        $.put(SCH, $.call(this.rangeStrFn(), $.l(LB), $.i(0), $.alen($.l(LB))));
        $.put(USER, this.obNew($));
        $.put(PASS, this.obNew($));
        $.put(PATH, this.obNew($));
        $.put(PORT, $.i(-1));
        $.if($.eq($.l(TYPE), $.i(T_FILE)), () => go(ST_FILE), () => {
          $.if($.l(SP), () => go(ST_SAS), () => {
            $.if($.andThen($.lt($.add($.l(P), $.i(1)), $.l(E)), $.eq(at($.add($.l(P), $.i(1))), $.i(47))), () => {
              go(ST_POA);
              inc();
            }, () => go(ST_OPAQUE));
          });
        });
        inc();
      } else {
        // SCHEME_START / SCHEME; no scheme starts over in NO_SCHEME
        $.if($.andThen(notEof(), this.isAlpha($, at($.l(P)))), () => {
          inc();
          $.while($.andThen(notEof(), this.isAlnumPlus($, at($.l(P)))), inc);
        });
        $.put(USER, this.obNew($));
        $.put(PASS, this.obNew($));
        $.put(PATH, this.obNew($));
        $.put(PORT, $.i(-1));
        $.if($.andThen($.gt($.l(P), $.l(S0)), cIs(58)), () => {
          $.put(LB, $.call(this.lowerCopyFn(), $.l(IN), $.l(S0), $.l(P)));
          $.put(TYPE, $.call(this.schemeTypeFn(), $.l(LB), $.i(0), $.alen($.l(LB))));
          $.put(SP, $.ne($.l(TYPE), $.i(T_NOT_SPECIAL)));
          $.put(SCH, $.call(this.rangeStrFn(), $.l(LB), $.i(0), $.alen($.l(LB))));
          $.if($.eq($.l(TYPE), $.i(T_FILE)), () => go(ST_FILE), () => {
            $.if($.both($.l(SP), $.eq(bg(U_TYPE), $.l(TYPE))), () => go(ST_SROA), () => {
              $.if($.l(SP), () => go(ST_SAS), () => {
                $.if($.andThen($.lt($.add($.l(P), $.i(1)), $.l(E)), $.eq(at($.add($.l(P), $.i(1))), $.i(47))), () => {
                  go(ST_POA);
                  inc();
                }, () => go(ST_OPAQUE));
              });
            });
          });
          inc();
        }, () => {
          $.put(P, $.l(S0));
          go(ST_NO_SCHEME);
        });
      }
      const copyScheme = (): void => {
        $.put(SCH, bg(U_SCHEME));
        $.put(TYPE, bg(U_TYPE));
        $.put(SP, $.ne($.l(TYPE), $.i(T_NOT_SPECIAL)));
      };
      const copyAuthority = (): void => {
        $.put(USER, obFrom(bg(U_USER)));
        $.put(PASS, obFrom(bg(U_PASS)));
        $.put(HOST, bg(U_HOST));
        $.put(PORT, bg(U_PORT));
      };
      const baseStates = (): [number, () => void][] => [
        [ST_NO_SCHEME, () => {
          // an opaque-path base admits only a bare "#fragment" (ada lets
          // any input with a fragment fall through to RELATIVE_SCHEME)
          $.if($.both(bg(U_OPAQUE), $.lt($.l(FF), $.i(0))), fail);
          copyScheme();
          $.if($.both(bg(U_OPAQUE), $.eq($.l(P), $.l(E))), () => {
            $.put(OPQ, $.i(1));
            $.put(PATH, obFrom(bg(U_PATH)));
            $.put(QUERY, bg(U_QUERY));
            $.put(P, $.add($.l(E), $.i(1)));
          }, () => {
            $.if($.ne($.l(TYPE), $.i(T_FILE)), () => go(ST_REL), () => go(ST_FILE));
          });
        }],
        [ST_SROA, () => {
          $.if($.andThen($.lt($.add($.l(P), $.i(1)), $.l(E)), $.both($.eq(at($.l(P)), $.i(47)), $.eq(at($.add($.l(P), $.i(1))), $.i(47)))), () => {
            $.put(P, $.add($.l(P), $.i(2)));
            go(ST_SAIS);
          }, () => go(ST_REL));
        }],
        [ST_REL, () => {
          copyScheme();
          $.if($.either(cIs(47), $.both($.l(SP), cIs(92))), () => {
            go(ST_REL_SLASH);
            inc();
          }, () => {
            copyAuthority();
            $.put(OPQ, bg(U_OPAQUE));
            $.put(PATH, obFrom(bg(U_PATH)));
            $.put(QUERY, bg(U_QUERY));
            $.if(cIs(63), () => {
              go(ST_QUERY);
              inc();
            }, () => {
              $.if(notEof(), () => {
                $.put(QUERY, $.nul(this.S));
                $.run(this.shortenFn(), $.l(PATH), $.l(TYPE));
                go(ST_PATH);
              }, inc);
            });
          });
        }],
        [ST_REL_SLASH, () => {
          $.if($.both($.l(SP), cSlash()), () => {
            go(ST_SAIS);
            inc();
          }, () => {
            $.if(cIs(47), () => {
              go(ST_AUTHORITY);
              inc();
            }, () => {
              copyAuthority();
              go(ST_PATH);
            });
          });
        }],
      ];
      const chain = (cases: [number, () => void][], last: () => void): void => {
        const [s, body] = cases[0]!;
        if (cases.length === 1) $.if(is(s), body, last);
        else $.if(is(s), body, () => chain(cases.slice(1), last));
      };
      $.while($.le($.l(P), $.l(E)), () => {
        chain([
          [ST_FILE, () => {
            $.put(HOST, empty());
            if (!withBase) {
              $.if(cSlash(), () => {
                go(ST_FILE_SLASH);
                inc();
              }, () => go(ST_PATH));
              return;
            }
            $.if(cSlash(), () => {
              go(ST_FILE_SLASH);
              inc();
            }, () => {
              // a file base: its host, path and query, then '?' replaces
              // the query, and any other input drops it and either empties
              // the path (a drive letter follows) or shortens it
              $.if($.eq(bg(U_TYPE), $.i(T_FILE)), () => {
                $.put(HOST, bg(U_HOST));
                $.put(PATH, obFrom(bg(U_PATH)));
                $.put(QUERY, bg(U_QUERY));
                $.put(OPQ, bg(U_OPAQUE));
                $.if(cIs(63), () => {
                  go(ST_QUERY);
                  inc();
                }, () => {
                  $.if(notEof(), () => {
                    $.put(QUERY, $.nul(this.S));
                    $.if($.call(this.winDriveFn(), $.l(IN), $.l(P), $.l(E)), () => $.put(PATH, this.obNew($)), () => {
                      $.run(this.shortenFn(), $.l(PATH), $.l(TYPE));
                    });
                    go(ST_PATH);
                  }, inc);
                });
              }, () => go(ST_PATH));
            });
          }],
          [ST_FILE_SLASH, () => {
            if (!withBase) {
              $.if(cSlash(), () => {
                go(ST_FILE_HOST);
                inc();
              }, () => go(ST_PATH));
              return;
            }
            $.if(cSlash(), () => {
              go(ST_FILE_HOST);
              inc();
            }, () => {
              // a file base: its host, and its first path segment when that
              // is a normalized drive letter (ada: two or more bytes, an
              // alpha then ':') and the rest does not start with one
              $.if($.eq(bg(U_TYPE), $.i(T_FILE)), () => {
                $.put(HOST, bg(U_HOST));
                $.put(BP, bg(U_PATH));
                $.if($.andThen($.gt($.alen($.l(BP)), $.i(0)), $.not($.call(this.winDriveFn(), $.l(IN), $.l(P), $.l(E)))), () => {
                  $.put(BK, $.i(1));
                  $.while($.andThen($.lt($.l(BK), $.alen($.l(BP))), $.ne($.agetU(this.S, $.l(BP), $.l(BK)), $.i(47))), () => $.put(BK, $.add($.l(BK), $.i(1))));
                  $.if($.andThen($.ge($.sub($.l(BK), $.i(1)), $.i(2)), $.both(this.isAlpha($, $.agetU(this.S, $.l(BP), $.i(1))), $.eq($.agetU(this.S, $.l(BP), $.i(2)), $.i(58)))), () => {
                    $.for(BI, $.i(0), $.l(BK), () => this.push($, $.l(PATH), $.and($.agetU(this.S, $.l(BP), $.l(BI)), $.i(0xff))));
                  });
                });
              });
              go(ST_PATH);
            });
          }],
          [ST_FILE_HOST, () => {
            $.put(L, $.l(P));
            $.while($.andThen($.lt($.l(L), $.l(E)), $.not(this.isAny($, at($.l(L)), "/\\?"))), () => $.put(L, $.add($.l(L), $.i(1))));
            $.if($.call(this.winDriveFn(), $.l(IN), $.l(P), $.l(L)), () => go(ST_PATH), () => {
              $.if($.eq($.l(L), $.l(P)), () => {
                $.put(HOST, empty());
                go(ST_PATH_START);
              }, () => {
                $.put(HS, parseHost($.l(P), $.l(L)));
                $.if($.isNull($.l(HS)), fail);
                $.if($.call(this.strIsFn(), $.l(HS), this.lit($, "localhost")), () => $.put(HS, empty()));
                $.put(HOST, $.l(HS));
                $.put(P, $.l(L));
                go(ST_PATH_START);
              });
            });
          }],
          [ST_SAS, () => {
            $.if($.andThen($.lt($.add($.l(P), $.i(1)), $.l(E)), $.both($.eq(at($.l(P)), $.i(47)), $.eq(at($.add($.l(P), $.i(1))), $.i(47)))), () => $.put(P, $.add($.l(P), $.i(2))));
            go(ST_SAIS);
          }],
          [ST_SAIS, () => {
            $.while(cSlash(), inc);
            go(ST_AUTHORITY);
          }],
          [ST_POA, () => {
            $.if(cIs(47), () => {
              go(ST_AUTHORITY);
              inc();
            }, () => go(ST_PATH));
          }],
          [ST_AUTHORITY, () => {
            $.if($.lt(this.find($, $.l(IN), $.l(P), $.l(E), 64), $.l(E)), () => {
              $.put(P, $.call(this.authorityFn(), $.l(IN), $.l(P), $.l(E), $.l(SP), $.l(USER), $.l(PASS)));
              $.if($.lt($.l(P), $.i(0)), fail);
            });
            go(ST_HOST);
          }],
          [ST_HOST, () => {
            $.put(L, $.call(this.hostDelimFn(), $.l(IN), $.l(P), $.l(E), $.l(SP)));
            $.if($.andThen($.lt($.l(L), $.l(E)), $.eq(at($.l(L)), $.i(58))), () => {
              $.put(HOST, parseHost($.l(P), $.l(L)));
              $.if($.isNull($.l(HOST)), fail);
              $.put(P, $.add($.l(L), $.i(1)));
              go(ST_PORT);
            }, () => {
              $.if($.eq($.l(L), $.l(P)), () => {
                $.if($.l(SP), fail);
                $.put(HOST, empty());
              }, () => {
                $.put(HOST, parseHost($.l(P), $.l(L)));
                $.if($.isNull($.l(HOST)), fail);
              });
              $.put(P, $.l(L));
              go(ST_PATH_START);
            });
          }],
          [ST_PORT, () => {
            // url::parse_port(view, true)
            $.if(cIs(45), fail);
            $.put(D, $.l(P));
            $.put(V, $.i(0));
            $.put(OVF, $.i(0));
            $.while($.andThen($.lt($.l(D), $.l(E)), this.isDigit($, at($.l(D)))), () => {
              $.put(V, $.add($.mul($.l(V), $.i(10)), $.sub(at($.l(D)), $.i(48))));
              $.if($.gt($.l(V), $.i(65535)), () => {
                $.put(OVF, $.i(1));
                $.put(V, $.i(70000));
              });
              $.put(D, $.add($.l(D), $.i(1)));
            });
            $.if($.l(OVF), fail);
            $.if($.not($.orElse($.eq($.l(D), $.l(E)), $.either(this.isAny($, at($.l(D)), "/?"), $.both($.l(SP), $.eq(at($.l(D)), $.i(92)))))), fail);
            $.if($.eq($.l(D), $.l(P)), () => $.put(PORT, $.i(-1)), () => {
              $.put(DP, $.call(this.defaultPortFn(), $.l(TYPE)));
              $.put(PORT, $.sel(I32, $.either($.both($.not($.l(DP)), $.not($.l(V))), $.ne($.l(DP), $.l(V))), $.l(V), $.i(-1)));
            });
            $.put(P, $.l(D));
            go(ST_PATH_START);
          }],
          [ST_PATH_START, () => {
            $.if($.l(SP), () => {
              go(ST_PATH);
              $.if($.not(notEof()), () => {
                this.push($, $.l(PATH), $.i(47));
                $.put(P, $.add($.l(E), $.i(1)));
              }, () => {
                $.if(this.isSlash($, at($.l(P))), inc);
              });
            }, () => {
              $.if(cIs(63), () => {
                go(ST_QUERY);
                inc();
              }, () => {
                $.if(notEof(), () => {
                  go(ST_PATH);
                  $.if($.eq(at($.l(P)), $.i(47)), inc);
                }, inc);
              });
            });
          }],
          [ST_PATH, () => {
            $.put(Q, this.find($, $.l(IN), $.l(P), $.l(E), 63));
            $.run(this.parsePathFn(), $.l(IN), $.l(P), $.l(Q), $.l(TYPE), $.l(PATH));
            $.if($.lt($.l(Q), $.l(E)), () => {
              go(ST_QUERY);
              $.put(P, $.add($.l(Q), $.i(1)));
            }, () => $.put(P, $.add($.l(E), $.i(1))));
          }],
          [ST_OPAQUE, () => {
            $.put(Q, this.find($, $.l(IN), $.l(P), $.l(E), 63));
            $.put(OPQ, $.i(1));
            $.if($.andThen($.gt($.l(Q), $.l(P)), $.eq(at($.sub($.l(Q), $.i(1))), $.i(32))), () => {
              this.pctEnc($, $.l(PATH), $.l(IN), $.l(P), $.sub($.l(Q), $.i(1)), SET_C0);
              this.pushLit($, $.l(PATH), "%20");
            }, () => this.pctEnc($, $.l(PATH), $.l(IN), $.l(P), $.l(Q), SET_C0));
            $.if($.lt($.l(Q), $.l(E)), () => {
              go(ST_QUERY);
              $.put(P, $.add($.l(Q), $.i(1)));
            }, () => $.put(P, $.add($.l(E), $.i(1))));
          }],
          ...(withBase ? baseStates() : []),
        ], () => {
          // QUERY
          $.put(O, this.obNew($));
          this.pctEnc($, $.l(O), $.l(IN), $.l(P), $.l(E), $.sel(I32, $.l(SP), $.i(SET_SPECIAL_QUERY), $.i(SET_QUERY)));
          $.put(QUERY, this.obStr($, $.l(O)));
          $.put(P, $.add($.l(E), $.i(1)));
        });
      });
      $.if($.ge($.l(FF), $.i(0)), () => {
        $.put(O, this.obNew($));
        this.pctEnc($, $.l(O), $.l(IN), $.l(FF), $.l(FT), SET_FRAGMENT);
        $.put(FRAG, this.obStr($, $.l(O)));
      });
      $.do($.new_(
        this.urlType(),
        $.l(SCH),
        $.l(TYPE),
        this.obStr($, $.l(USER)),
        this.obStr($, $.l(PASS)),
        $.l(HOST),
        $.l(PORT),
        this.obStr($, $.l(PATH)),
        $.l(OPQ),
        $.l(QUERY),
        $.l(FRAG),
        $.nul(EQ_HEAP),
      ));
    }
  }

  /** scheme default port by type */
  defaultPortFn(): number {
    return this.fn("defaultPort", [I32], [I32], (_f, $) => {
      for (let t = 0; t < DEFAULT_PORTS.length; t++) {
        if (DEFAULT_PORTS[t] !== 0) $.if($.eq($.l(0), $.i(t)), () => $.ret($.i(DEFAULT_PORTS[t]!)));
      }
      $.do($.i(0));
    });
  }

  /** (a, b) string equality */
  strIsFn(): number {
    return this.fn("strIs", [this.sRef, this.sRef], [I32], (f, $) => {
      const [A_, B_] = [0, 1];
      const I = f.local(I32);
      $.if($.ne($.alen($.l(A_)), $.alen($.l(B_))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.alen($.l(A_)), () => $.if($.ne($.agetU(this.S, $.l(A_), $.l(I)), $.agetU(this.S, $.l(B_), $.l(I))), () => $.ret($.i(0))));
      $.do($.i(1));
    });
  }

  /** `new URL(str)`: the URL, or Node's "Invalid URL" TypeError pending
   * (and null). */
  newFn(): number {
    return this.fn("new", [this.sRef], [this.urlRef()], (f, $) => {
      const U = f.local(this.urlRef());
      $.put(U, $.call(this.parseFn(), $.call(this.utf8Fn(), $.l(0))));
      $.if($.isNull($.l(U)), () => this.throwType($, "Invalid URL", "ERR_INVALID_URL"));
      $.do($.l(U));
    });
  }

  /** `new URL(str, base)` with a defined base (both already strings):
   * Node parses the base first — a bad one is "Invalid URL" before the
   * input is read — then the input against it. */
  newBaseFn(): number {
    return this.fn("newBase", [this.sRef, this.sRef], [this.urlRef()], (f, $) => {
      const B = f.local(this.urlRef());
      const U = f.local(this.urlRef());
      $.put(B, $.call(this.parseFn(), $.call(this.utf8Fn(), $.l(1))));
      $.if($.isNull($.l(B)), () => {
        this.throwType($, "Invalid URL", "ERR_INVALID_URL");
        $.ret($.l(B));
      });
      $.put(U, $.call(this.parseBaseFn(), $.call(this.utf8Fn(), $.l(0)), $.l(B)));
      $.if($.isNull($.l(U)), () => this.throwType($, "Invalid URL", "ERR_INVALID_URL"));
      $.do($.l(U));
    });
  }

  /** `URL.parse(str)`: the URL, or null. */
  parseOrNullFn(): number {
    return this.fn("parseOrNull", [this.sRef], [this.urlRef()], (_f, $) => {
      $.do($.call(this.parseFn(), $.call(this.utf8Fn(), $.l(0))));
    });
  }

  /** `URL.parse(str, base)`: null when the base or the input fails. */
  parseBaseOrNullFn(): number {
    return this.fn("parseBaseOrNull", [this.sRef, this.sRef], [this.urlRef()], (f, $) => {
      const B = f.local(this.urlRef());
      $.put(B, $.call(this.parseFn(), $.call(this.utf8Fn(), $.l(1))));
      $.if($.isNull($.l(B)), () => $.ret($.l(B)));
      $.do($.call(this.parseBaseFn(), $.call(this.utf8Fn(), $.l(0)), $.l(B)));
    });
  }

  /** `URL.canParse(str)` */
  canParseFn(): number {
    return this.fn("canParse", [this.sRef], [I32], (_f, $) => {
      $.do($.notNull($.call(this.parseOrNullFn(), $.l(0))));
    });
  }

  /** `URL.canParse(str, base)` */
  canParseBaseFn(): number {
    return this.fn("canParseBase", [this.sRef, this.sRef], [I32], (_f, $) => {
      $.do($.notNull($.call(this.parseBaseOrNullFn(), $.l(0), $.l(1))));
    });
  }

  /* ── getters (lib/internal/url.js over ada's href) ────────────────── */

  /** url::get_href */
  hrefFn(): number {
    return this.fn("href", [this.urlRef()], [this.sRef], (f, $) => {
      const U = 0;
      const O = f.local(this.obRef);
      const g = (i: number): X => $.get(this.urlType(), i, $.l(U));
      const app = (s: X): void => $.run(this.obAppendStrFn(), $.l(O), s);
      $.put(O, this.obNew($));
      app(g(U_SCHEME));
      this.push($, $.l(O), $.i(58));
      $.if($.notNull(g(U_HOST)), () => {
        this.pushLit($, $.l(O), "//");
        $.if($.either($.gt($.alen(g(U_USER)), $.i(0)), $.gt($.alen(g(U_PASS)), $.i(0))), () => {
          app(g(U_USER));
          $.if($.gt($.alen(g(U_PASS)), $.i(0)), () => {
            this.push($, $.l(O), $.i(58));
            app(g(U_PASS));
          });
          this.push($, $.l(O), $.i(64));
        });
        app(g(U_HOST));
        $.if($.ge(g(U_PORT), $.i(0)), () => {
          this.push($, $.l(O), $.i(58));
          $.run(this.itoaFn(), $.l(O), g(U_PORT));
        });
      }, () => {
        $.if($.andThen($.not(g(U_OPAQUE)), $.andThen($.ge($.alen(g(U_PATH)), $.i(2)), $.both($.eq($.agetU(this.S, g(U_PATH), $.i(0)), $.i(47)), $.eq($.agetU(this.S, g(U_PATH), $.i(1)), $.i(47))))), () => this.pushLit($, $.l(O), "/."));
      });
      app(g(U_PATH));
      $.if($.notNull(g(U_QUERY)), () => {
        this.push($, $.l(O), $.i(63));
        app(g(U_QUERY));
      });
      $.if($.notNull(g(U_FRAG)), () => {
        this.push($, $.l(O), $.i(35));
        app(g(U_FRAG));
      });
      $.do(this.obStr($, $.l(O)));
    });
  }

  protocolFn(): number {
    return this.fn("protocol", [this.urlRef()], [this.sRef], (f, $) => {
      const O = f.local(this.obRef);
      $.put(O, this.obNew($));
      $.run(this.obAppendStrFn(), $.l(O), $.get(this.urlType(), U_SCHEME, $.l(0)));
      this.push($, $.l(O), $.i(58));
      $.do(this.obStr($, $.l(O)));
    });
  }

  hostFn(): number {
    return this.fn("host", [this.urlRef()], [this.sRef], (f, $) => {
      const O = f.local(this.obRef);
      const g = (i: number): X => $.get(this.urlType(), i, $.l(0));
      $.if($.isNull(g(U_HOST)), () => $.ret($.anew(this.S, $.i(0))));
      $.if($.lt(g(U_PORT), $.i(0)), () => $.ret(g(U_HOST)));
      $.put(O, this.obNew($));
      $.run(this.obAppendStrFn(), $.l(O), g(U_HOST));
      this.push($, $.l(O), $.i(58));
      $.run(this.itoaFn(), $.l(O), g(U_PORT));
      $.do(this.obStr($, $.l(O)));
    });
  }

  hostnameFn(): number {
    return this.fn("hostname", [this.urlRef()], [this.sRef], (_f, $) => {
      const h = $.get(this.urlType(), U_HOST, $.l(0));
      $.do($.sel(this.sRef, $.isNull(h), $.anew(this.S, $.i(0)), h));
    });
  }

  pathnameFn(): number {
    return this.fn("pathname", [this.urlRef()], [this.sRef], (_f, $) => {
      $.do($.get(this.urlType(), U_PATH, $.l(0)));
    });
  }

  /** url.search: "" for no query and for an empty one. */
  searchFn(): number {
    return this.fn("search", [this.urlRef()], [this.sRef], (f, $) => {
      const Q = f.local(this.sRef);
      const O = f.local(this.obRef);
      $.put(Q, $.get(this.urlType(), U_QUERY, $.l(0)));
      $.if($.orElse($.isNull($.l(Q)), $.not($.alen($.l(Q)))), () => $.ret($.anew(this.S, $.i(0))));
      $.put(O, this.obNew($));
      this.push($, $.l(O), $.i(63));
      $.run(this.obAppendStrFn(), $.l(O), $.l(Q));
      $.do(this.obStr($, $.l(O)));
    });
  }

  /* ── UTF-16 buffers ───────────────────────────────────────────────── */

  private obT16_: number | null = null;
  private get UB(): number {
    this.obT16_ ??= this.mb.openStructType("url:u16buf", [
      { storage: this.sRef, mutable: true },
      { storage: I32, mutable: true },
    ]);
    return this.obT16_;
  }
  get ubRef(): ValType {
    return this.ref(this.UB);
  }
  ubNew($: A): X {
    return $.new_(this.UB, $.anew(this.S, $.i(16)), $.i(0));
  }
  /** The buffer's length in code units (querystring.ts reads it). */
  ubLen($: A, ub: X): X {
    return $.get(this.UB, OB_N, ub);
  }
  ubPushFn(): number {
    return this.fn("ubPush", [this.ubRef, I32], [], (f, $) => {
      const [O, V] = [0, 1];
      const N = f.local(I32);
      const NA = f.local(this.sRef);
      $.put(N, $.get(this.UB, OB_N, $.l(O)));
      $.if($.ge($.l(N), $.alen($.get(this.UB, OB_A, $.l(O)))), () => {
        $.put(NA, $.anew(this.S, $.add($.mul($.l(N), $.i(2)), $.i(8))));
        $.do($.l(NA), $.i(0), $.get(this.UB, OB_A, $.l(O)), $.i(0), $.l(N));
        $.c.arrayCopy(this.S, this.S);
        $.set(this.UB, OB_A, $.l(O), $.l(NA));
      });
      $.aset(this.S, $.get(this.UB, OB_A, $.l(O)), $.l(N), $.l(V));
      $.set(this.UB, OB_N, $.l(O), $.add($.l(N), $.i(1)));
    });
  }
  private upush($: A, ub: X, v: X): void {
    $.run(this.ubPushFn(), ub, v);
  }
  /** ub += str[from, to) */
  ubAppendFn(): number {
    return this.fn("ubAppend", [this.ubRef, this.sRef, I32, I32], [], (f, $) => {
      const [O, STR, FROM, TO] = [0, 1, 2, 3];
      const I = f.local(I32);
      $.for(I, $.l(FROM), $.l(TO), () => this.upush($, $.l(O), $.agetU(this.S, $.l(STR), $.l(I))));
    });
  }
  ubToStrFn(): number {
    return this.fn("ubToStr", [this.ubRef], [this.sRef], (f, $) => {
      const O = 0;
      const R = f.local(this.sRef);
      $.put(R, $.anew(this.S, $.get(this.UB, OB_N, $.l(O))));
      $.do($.l(R), $.i(0), $.get(this.UB, OB_A, $.l(O)), $.i(0), $.get(this.UB, OB_N, $.l(O)));
      $.c.arrayCopy(this.S, this.S);
      $.do($.l(R));
    });
  }
  /** ub += code point (a pair above U+FFFF) */
  ubPushCpFn(): number {
    return this.fn("ubPushCp", [this.ubRef, I32], [], (_f, $) => {
      const [O, C] = [0, 1];
      $.if($.lt($.l(C), $.i(0x10000)), () => this.upush($, $.l(O), $.l(C)), () => {
        this.upush($, $.l(O), $.add($.i(0xd800), $.shrU($.sub($.l(C), $.i(0x10000)), $.i(10))));
        this.upush($, $.l(O), $.add($.i(0xdc00), $.and($.sub($.l(C), $.i(0x10000)), $.i(0x3ff))));
      });
    });
  }

  /** String.prototype.toWellFormed */
  wellFormedFn(): number {
    return this.fn("wellFormed", [this.sRef], [this.sRef], (f, $) => {
      const STR = 0;
      const R = f.local(this.sRef);
      const I = f.local(I32);
      const N = f.local(I32);
      const C = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      $.put(N, $.alen($.l(STR)));
      $.put(R, $.l(STR));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu($.l(I)));
        $.if($.eq($.and($.l(C), $.i(0xfc00)), $.i(0xd800)), () => {
          $.if($.andThen($.lt($.add($.l(I), $.i(1)), $.l(N)), $.eq($.and(cu($.add($.l(I), $.i(1))), $.i(0xfc00)), $.i(0xdc00))), () => {
            $.put(I, $.add($.l(I), $.i(1)));
          }, () => this.wfFix($, R, STR, I, N));
        }, () => {
          $.if($.eq($.and($.l(C), $.i(0xfc00)), $.i(0xdc00)), () => this.wfFix($, R, STR, I, N));
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.do($.l(R));
    });
  }
  /** Copy-on-first-write, then U+FFFD at R[I]. */
  private wfFix($: A, R: number, STR: number, I: number, N: number): void {
    $.if($.refEq($.l(R), $.l(STR)), () => {
      $.put(R, $.anew(this.S, $.l(N)));
      $.do($.l(R), $.i(0), $.l(STR), $.i(0), $.l(N));
      $.c.arrayCopy(this.S, this.S);
    });
    $.aset(this.S, $.l(R), $.l(I), $.i(0xfffd));
  }

  /** WHATWG UTF-8 decode (replacement per maximal subpart) of
   * bytes[0, n) — Buffer#toString('utf8'). */
  utf8DecodeFn(): number {
    return this.fn("utf8Decode", [this.bRef, I32], [this.sRef], (f, $) => {
      const [BY, N] = [0, 1];
      const O = f.local(this.ubRef);
      const I = f.local(I32);
      const B = f.local(I32);
      const NEED = f.local(I32);
      const SEEN = f.local(I32);
      const CP = f.local(I32);
      const LO = f.local(I32);
      const HI = f.local(I32);
      $.put(O, this.ubNew($));
      $.put(LO, $.i(0x80));
      $.put(HI, $.i(0xbf));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(B, this.u8($, $.l(BY), $.l(I)));
        $.if($.not($.l(NEED)), () => {
          $.if($.le($.l(B), $.i(0x7f)), () => this.upush($, $.l(O), $.l(B)), () => {
            $.if($.both($.ge($.l(B), $.i(0xc2)), $.le($.l(B), $.i(0xdf))), () => {
              $.put(NEED, $.i(1));
              $.put(CP, $.and($.l(B), $.i(0x1f)));
            }, () => {
              $.if($.both($.ge($.l(B), $.i(0xe0)), $.le($.l(B), $.i(0xef))), () => {
                $.if($.eq($.l(B), $.i(0xe0)), () => $.put(LO, $.i(0xa0)));
                $.if($.eq($.l(B), $.i(0xed)), () => $.put(HI, $.i(0x9f)));
                $.put(NEED, $.i(2));
                $.put(CP, $.and($.l(B), $.i(0xf)));
              }, () => {
                $.if($.both($.ge($.l(B), $.i(0xf0)), $.le($.l(B), $.i(0xf4))), () => {
                  $.if($.eq($.l(B), $.i(0xf0)), () => $.put(LO, $.i(0x90)));
                  $.if($.eq($.l(B), $.i(0xf4)), () => $.put(HI, $.i(0x8f)));
                  $.put(NEED, $.i(3));
                  $.put(CP, $.and($.l(B), $.i(7)));
                }, () => this.upush($, $.l(O), $.i(0xfffd)));
              });
            });
          });
          $.put(I, $.add($.l(I), $.i(1)));
        }, () => {
          $.if($.not($.both($.ge($.l(B), $.l(LO)), $.le($.l(B), $.l(HI)))), () => {
            $.put(CP, $.i(0));
            $.put(NEED, $.i(0));
            $.put(SEEN, $.i(0));
            $.put(LO, $.i(0x80));
            $.put(HI, $.i(0xbf));
            this.upush($, $.l(O), $.i(0xfffd));
            // the byte is processed again
          }, () => {
            $.put(LO, $.i(0x80));
            $.put(HI, $.i(0xbf));
            $.put(CP, $.or($.shl($.l(CP), $.i(6)), $.and($.l(B), $.i(0x3f))));
            $.put(SEEN, $.add($.l(SEEN), $.i(1)));
            $.if($.eq($.l(SEEN), $.l(NEED)), () => {
              $.run(this.ubPushCpFn(), $.l(O), $.l(CP));
              $.put(CP, $.i(0));
              $.put(NEED, $.i(0));
              $.put(SEEN, $.i(0));
            });
            $.put(I, $.add($.l(I), $.i(1)));
          });
        });
      });
      $.if($.l(NEED), () => this.upush($, $.l(O), $.i(0xfffd)));
      $.do($.call(this.ubToStrFn(), $.l(O)));
    });
  }

  private isHex16($: A, c: X): X {
    return $.both($.lt(c, $.i(128)), this.isHexDigit($, c));
  }

  /** decodeURIComponent without the throw: the decoded string, or null
   * where it would throw URIError. */
  strictDecodeFn(): number {
    return this.fn("strictDecode", [this.sRef], [this.sRef], (f, $) => {
      const STR = 0;
      const O = f.local(this.ubRef);
      const I = f.local(I32);
      const N = f.local(I32);
      const C = f.local(I32);
      const B = f.local(I32);
      const K = f.local(I32);
      const CNT = f.local(I32);
      const CP = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      // one %XX at I, or -1
      const esc = (): X => $.sel(I32,
        $.andThen($.le($.add($.l(I), $.i(3)), $.l(N)), $.both($.eq(cu($.l(I)), $.i(37)), $.both(this.isHex16($, cu($.add($.l(I), $.i(1)))), this.isHex16($, cu($.add($.l(I), $.i(2))))))),
        $.add($.mul(this.hexVal($, cu($.add($.l(I), $.i(1)))), $.i(16)), this.hexVal($, cu($.add($.l(I), $.i(2))))),
        $.i(-1));
      const nul = (): void => $.ret($.nul(this.S));
      $.put(O, this.ubNew($));
      $.put(N, $.alen($.l(STR)));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu($.l(I)));
        $.if($.ne($.l(C), $.i(37)), () => {
          this.upush($, $.l(O), $.l(C));
          $.put(I, $.add($.l(I), $.i(1)));
        }, () => {
          $.put(B, esc());
          $.if($.lt($.l(B), $.i(0)), nul);
          $.put(I, $.add($.l(I), $.i(3)));
          $.if($.lt($.l(B), $.i(0x80)), () => this.upush($, $.l(O), $.l(B)), () => {
            $.put(CNT, $.sel(I32, $.eq($.and($.l(B), $.i(0xe0)), $.i(0xc0)), $.i(2), $.sel(I32, $.eq($.and($.l(B), $.i(0xf0)), $.i(0xe0)), $.i(3), $.sel(I32, $.eq($.and($.l(B), $.i(0xf8)), $.i(0xf0)), $.i(4), $.i(0)))));
            $.if($.not($.l(CNT)), nul);
            $.put(CP, $.and($.l(B), $.shrU($.i(0xff), $.add($.l(CNT), $.i(1)))));
            $.for(K, $.i(1), $.l(CNT), () => {
              $.put(B, esc());
              $.if($.orElse($.lt($.l(B), $.i(0)), $.ne($.and($.l(B), $.i(0xc0)), $.i(0x80))), nul);
              $.put(I, $.add($.l(I), $.i(3)));
              $.put(CP, $.or($.shl($.l(CP), $.i(6)), $.and($.l(B), $.i(0x3f))));
            });
            // overlong, surrogate, out of range
            $.if($.lt($.l(CP), $.sel(I32, $.eq($.l(CNT), $.i(2)), $.i(0x80), $.sel(I32, $.eq($.l(CNT), $.i(3)), $.i(0x800), $.i(0x10000)))), nul);
            $.if($.both($.ge($.l(CP), $.i(0xd800)), $.le($.l(CP), $.i(0xdfff))), nul);
            $.if($.gt($.l(CP), $.i(0x10ffff)), nul);
            $.run(this.ubPushCpFn(), $.l(O), $.l(CP));
          });
        });
      });
      $.do($.call(this.ubToStrFn(), $.l(O)));
    });
  }

  /** querystring.unescape (qsUnescape): decodeURIComponent, else
   * unescapeBuffer(s).toString(). */
  qsUnescapeFn(): number {
    return this.fn("qsUnescape", [this.sRef], [this.sRef], (f, $) => {
      const STR = 0;
      const R = f.local(this.sRef);
      const OUT = f.local(this.bRef);
      const I = f.local(I32);
      const OI = f.local(I32);
      const N = f.local(I32);
      const C = f.local(I32);
      const HH = f.local(I32);
      const HL = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      const unhex = (c: X): X => $.sel(I32, this.isHex16($, c), this.hexVal($, c), $.i(-1));
      $.put(R, $.call(this.strictDecodeFn(), $.l(STR)));
      $.if($.notNull($.l(R)), () => $.ret($.l(R)));
      $.put(N, $.alen($.l(STR)));
      $.put(OUT, $.anew(this.B8, $.l(N)));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu($.l(I)));
        $.if($.both($.eq($.l(C), $.i(37)), $.lt($.l(I), $.sub($.l(N), $.i(2)))), () => {
          $.put(I, $.add($.l(I), $.i(1)));
          $.put(C, cu($.l(I)));
          $.put(HH, unhex($.l(C)));
          $.if($.lt($.l(HH), $.i(0)), () => {
            $.put(C, $.i(37)); // '%', then this character is read again
            $.put(I, $.sub($.l(I), $.i(1)));
          }, () => {
            $.put(I, $.add($.l(I), $.i(1)));
            $.put(HL, unhex(cu($.l(I))));
            $.if($.lt($.l(HL), $.i(0)), () => {
              $.put(C, $.i(37));
              $.put(I, $.sub($.l(I), $.i(2)));
            }, () => $.put(C, $.add($.mul($.l(HH), $.i(16)), $.l(HL))));
          });
        });
        $.aset(this.B8, $.l(OUT), $.l(OI), $.l(C));
        $.put(OI, $.add($.l(OI), $.i(1)));
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.do($.call(this.utf8DecodeFn(), $.l(OUT), $.l(OI)));
    });
  }

  /* ── URLSearchParams (lib/internal/url.js) ────────────────────────── */

  spNewFn(): number {
    return this.fn("spNew", [], [this.spRef()], (_f, $) => {
      $.do($.new_(this.spType(), $.anew(this.listT, $.i(8)), $.i(0), $.nul(this.urlType())));
    });
  }
  /** list.push(s) */
  spPushFn(): number {
    return this.fn("spPush", [this.spRef(), this.sRef], [], (f, $) => {
      const [SP, V] = [0, 1];
      const N = f.local(I32);
      const NA = f.local(this.ref(this.listT));
      $.put(N, $.get(this.spType(), SP_N, $.l(SP)));
      $.if($.ge($.l(N), $.alen($.get(this.spType(), SP_LIST, $.l(SP)))), () => {
        $.put(NA, $.anew(this.listT, $.add($.mul($.l(N), $.i(2)), $.i(8))));
        $.do($.l(NA), $.i(0), $.get(this.spType(), SP_LIST, $.l(SP)), $.i(0), $.l(N));
        $.c.arrayCopy(this.listT, this.listT);
        $.set(this.spType(), SP_LIST, $.l(SP), $.l(NA));
      });
      $.aset(this.listT, $.get(this.spType(), SP_LIST, $.l(SP)), $.l(N), $.l(V));
      $.set(this.spType(), SP_N, $.l(SP), $.add($.l(N), $.i(1)));
    });
  }
  private item($: A, sp: X, i: X): X {
    // The list is a string[] buffer: string VALUES, read flat.
    return $.flat(this.S, $.aget(this.listT, $.get(this.spType(), SP_LIST, sp), i));
  }
  private setItem($: A, sp: X, i: X, v: X): void {
    $.aset(this.listT, $.get(this.spType(), SP_LIST, sp), i, v);
  }

  /** parseParams(qs) into a fresh list. */
  spParseFn(): number {
    return this.fn("spParse", [this.sRef], [this.spRef()], (f, $) => {
      const QS0 = 0;
      const QS = f.local(this.sRef);
      const SP = f.local(this.spRef());
      const N = f.local(I32);
      const I = f.local(I32);
      const C = f.local(I32);
      const SEEN = f.local(I32);
      const BUF = f.local(this.ubRef);
      const ENC = f.local(I32);
      const EC = f.local(I32);
      const PS = f.local(I32);
      const LP = f.local(I32);
      const S = f.local(this.sRef);
      $.put(QS, $.call(this.wellFormedFn(), $.l(QS0)));
      $.put(SP, $.call(this.spNewFn()));
      $.put(N, $.alen($.l(QS)));
      $.if($.not($.l(N)), () => $.ret($.l(SP)));
      $.put(BUF, this.ubNew($));
      $.put(I, $.sel(I32, $.eq($.agetU(this.S, $.l(QS), $.i(0)), $.i(63)), $.i(1), $.i(0)));
      $.put(PS, $.l(I));
      $.put(LP, $.l(I));
      const flush = (): void => {
        $.if($.lt($.l(LP), $.l(I)), () => $.run(this.ubAppendFn(), $.l(BUF), $.l(QS), $.l(LP), $.l(I)));
        $.put(S, $.call(this.ubToStrFn(), $.l(BUF)));
        $.if($.l(ENC), () => $.put(S, $.call(this.qsUnescapeFn(), $.l(S))));
        $.run(this.spPushFn(), $.l(SP), $.l(S));
      };
      const reset = (): void => {
        $.put(BUF, this.ubNew($));
        $.put(ENC, $.i(0));
        $.put(EC, $.i(0));
      };
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, $.agetU(this.S, $.l(QS), $.l(I)));
        $.if($.eq($.l(C), $.i(38)), () => {
          $.if($.eq($.l(PS), $.l(I)), () => {
            $.put(PS, $.add($.l(I), $.i(1)));
            $.put(LP, $.l(PS));
          }, () => {
            flush();
            $.if($.not($.l(SEEN)), () => $.run(this.spPushFn(), $.l(SP), $.anew(this.S, $.i(0))));
            $.put(SEEN, $.i(0));
            reset();
            $.put(PS, $.add($.l(I), $.i(1)));
            $.put(LP, $.l(PS));
          });
        }, () => {
          $.if($.both($.not($.l(SEEN)), $.eq($.l(C), $.i(61))), () => {
            flush();
            $.put(SEEN, $.i(1));
            reset();
            $.put(LP, $.add($.l(I), $.i(1)));
          }, () => {
            $.if($.eq($.l(C), $.i(43)), () => {
              $.if($.lt($.l(LP), $.l(I)), () => $.run(this.ubAppendFn(), $.l(BUF), $.l(QS), $.l(LP), $.l(I)));
              this.upush($, $.l(BUF), $.i(32));
              $.put(LP, $.add($.l(I), $.i(1)));
            }, () => {
              $.if($.not($.l(ENC)), () => {
                $.if($.eq($.l(C), $.i(37)), () => $.put(EC, $.i(1)), () => {
                  $.if($.gt($.l(EC), $.i(0)), () => {
                    $.if(this.isHex16($, $.l(C)), () => {
                      $.put(EC, $.add($.l(EC), $.i(1)));
                      $.if($.eq($.l(EC), $.i(3)), () => $.put(ENC, $.i(1)));
                    }, () => $.put(EC, $.i(0)));
                  });
                });
              });
            });
          });
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.if($.eq($.l(PS), $.l(I)), () => $.ret($.l(SP)));
      flush();
      $.if($.not($.l(SEEN)), () => $.run(this.spPushFn(), $.l(SP), $.anew(this.S, $.i(0))));
      $.do($.l(SP));
    });
  }

  /** encodeStr(s, noEscape, paramHexTable) appended to ub */
  private formEncodeFn(): number {
    return this.fn("formEncode", [this.ubRef, this.sRef], [], (f, $) => {
      const [O, STR] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      const C = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      const hex = (b: X): void => {
        this.upush($, $.l(O), $.i(37));
        this.upush($, $.l(O), this.hexUpper($, $.shrU(b, $.i(4))));
        this.upush($, $.l(O), this.hexUpper($, $.and(b, $.i(15))));
      };
      $.put(N, $.alen($.l(STR)));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu($.l(I)));
        $.if($.lt($.l(C), $.i(0x80)), () => {
          $.if($.either($.either(this.isAlpha($, $.l(C)), this.isDigit($, $.l(C))), this.isAny($, $.l(C), "*-._")), () => this.upush($, $.l(O), $.l(C)), () => {
            $.if($.eq($.l(C), $.i(32)), () => this.upush($, $.l(O), $.i(43)), () => hex($.l(C)));
          });
        }, () => {
          $.if($.lt($.l(C), $.i(0x800)), () => {
            hex($.or($.i(0xc0), $.shrU($.l(C), $.i(6))));
            hex($.or($.i(0x80), $.and($.l(C), $.i(0x3f))));
          }, () => {
            $.if($.either($.lt($.l(C), $.i(0xd800)), $.ge($.l(C), $.i(0xe000))), () => {
              hex($.or($.i(0xe0), $.shrU($.l(C), $.i(12))));
              hex($.or($.i(0x80), $.and($.shrU($.l(C), $.i(6)), $.i(0x3f))));
              hex($.or($.i(0x80), $.and($.l(C), $.i(0x3f))));
            }, () => {
              $.put(I, $.add($.l(I), $.i(1)));
              $.if($.ge($.l(I), $.l(N)), () => $.c.unreachable()); // never: the list is well-formed
              $.put(C, $.add($.i(0x10000), $.or($.shl($.and($.l(C), $.i(0x3ff)), $.i(10)), $.and(cu($.l(I)), $.i(0x3ff)))));
              hex($.or($.i(0xf0), $.shrU($.l(C), $.i(18))));
              hex($.or($.i(0x80), $.and($.shrU($.l(C), $.i(12)), $.i(0x3f))));
              hex($.or($.i(0x80), $.and($.shrU($.l(C), $.i(6)), $.i(0x3f))));
              hex($.or($.i(0x80), $.and($.l(C), $.i(0x3f))));
            });
          });
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });
    });
  }

  /** serializeParams */
  spToStringFn(): number {
    return this.fn("spToString", [this.spRef()], [this.sRef], (f, $) => {
      const SP = 0;
      const O = f.local(this.ubRef);
      const I = f.local(I32);
      $.put(O, this.ubNew($));
      $.for(I, $.i(0), $.get(this.spType(), SP_N, $.l(SP)), () => {
        $.if($.gt($.l(I), $.i(0)), () => this.upush($, $.l(O), $.sel(I32, $.and($.l(I), $.i(1)), $.i(61), $.i(38))));
        $.run(this.formEncodeFn(), $.l(O), this.item($, $.l(SP), $.l(I)));
      });
      $.do($.call(this.ubToStrFn(), $.l(O)));
    });
  }

  /** After a mutation: a view writes its list into its URL's query
   * (set_search("?" + params), or a null query for an empty list). */
  spSyncFn(): number {
    return this.fn("spSync", [this.spRef()], [], (f, $) => {
      const SP = 0;
      const U = f.local(this.urlRef());
      $.put(U, $.get(this.spType(), SP_URL, $.l(SP)));
      $.if($.isNull($.l(U)), () => $.ret());
      $.if($.not($.get(this.spType(), SP_N, $.l(SP))), () => $.set(this.urlType(), U_QUERY, $.l(U), $.nul(this.S)), () => {
        $.set(this.urlType(), U_QUERY, $.l(U), $.call(this.spToStringFn(), $.l(SP)));
      });
    });
  }

  /** url.searchParams: the one cached view. */
  searchParamsFn(): number {
    return this.fn("searchParams", [this.urlRef()], [this.spRef()], (f, $) => {
      const U = 0;
      const SP = f.local(this.spRef());
      $.if($.notNull($.get(this.urlType(), U_SP, $.l(U))), () => $.ret($.cast(this.spType(), $.get(this.urlType(), U_SP, $.l(U)))));
      $.put(SP, $.call(this.spParseFn(), $.call(this.searchFn(), $.l(U))));
      $.set(this.spType(), SP_URL, $.l(SP), $.l(U));
      $.set(this.urlType(), U_SP, $.l(U), $.l(SP));
      $.do($.l(SP));
    });
  }

  spCopyFn(): number {
    return this.fn("spCopy", [this.spRef()], [this.spRef()], (f, $) => {
      const SRC = 0;
      const SP = f.local(this.spRef());
      const I = f.local(I32);
      $.put(SP, $.call(this.spNewFn()));
      $.for(I, $.i(0), $.get(this.spType(), SP_N, $.l(SRC)), () => $.run(this.spPushFn(), $.l(SP), this.item($, $.l(SRC), $.l(I))));
      $.do($.l(SP));
    });
  }

  /** append(name, value) (also the record-literal `with` step) */
  spAppendFn(): number {
    return this.fn("spAppend", [this.spRef(), this.sRef, this.sRef], [], (_f, $) => {
      const [SP, K, V] = [0, 1, 2];
      $.run(this.spPushFn(), $.l(SP), $.call(this.wellFormedFn(), $.l(K)));
      $.run(this.spPushFn(), $.l(SP), $.call(this.wellFormedFn(), $.l(V)));
      $.run(this.spSyncFn(), $.l(SP));
    });
  }

  /** set(name, value) */
  spSetFn(): number {
    return this.fn("spSet", [this.spRef(), this.sRef, this.sRef], [], (f, $) => {
      const [SP, K0, V0] = [0, 1, 2];
      const K = f.local(this.sRef);
      const V = f.local(this.sRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const W = f.local(I32);
      const FOUND = f.local(I32);
      const KEEP = f.local(I32);
      const CUR = f.local(this.sRef);
      $.put(K, $.call(this.wellFormedFn(), $.l(K0)));
      $.put(V, $.call(this.wellFormedFn(), $.l(V0)));
      $.put(N, $.get(this.spType(), SP_N, $.l(SP)));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(CUR, this.item($, $.l(SP), $.l(I)));
        $.put(KEEP, $.i(1));
        $.if($.call(this.strIsFn(), $.l(CUR), $.l(K)), () => {
          $.if($.not($.l(FOUND)), () => {
            this.setItem($, $.l(SP), $.l(W), $.l(CUR));
            this.setItem($, $.l(SP), $.add($.l(W), $.i(1)), $.l(V));
            $.put(FOUND, $.i(1));
          }, () => $.put(KEEP, $.i(0)));
        }, () => {
          $.if($.ne($.l(W), $.l(I)), () => {
            this.setItem($, $.l(SP), $.l(W), $.l(CUR));
            this.setItem($, $.l(SP), $.add($.l(W), $.i(1)), this.item($, $.l(SP), $.add($.l(I), $.i(1))));
          });
        });
        $.if($.l(KEEP), () => $.put(W, $.add($.l(W), $.i(2))));
        $.put(I, $.add($.l(I), $.i(2)));
      });
      $.if($.l(FOUND), () => $.set(this.spType(), SP_N, $.l(SP), $.l(W)), () => {
        $.run(this.spPushFn(), $.l(SP), $.l(K));
        $.run(this.spPushFn(), $.l(SP), $.l(V));
      });
      $.run(this.spSyncFn(), $.l(SP));
    });
  }

  /** delete(name[, value]) — `value` null for the one-argument form. */
  spDeleteFn(): number {
    return this.fn("spDelete", [this.spRef(), this.sRef, this.sRef], [], (f, $) => {
      const [SP, K0, V0] = [0, 1, 2];
      const K = f.local(this.sRef);
      const V = f.local(this.sRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const W = f.local(I32);
      $.put(K, $.call(this.wellFormedFn(), $.l(K0)));
      $.if($.notNull($.l(V0)), () => $.put(V, $.call(this.wellFormedFn(), $.l(V0))));
      $.put(N, $.get(this.spType(), SP_N, $.l(SP)));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.if($.not($.andThen($.call(this.strIsFn(), this.item($, $.l(SP), $.l(I)), $.l(K)), $.orElse($.isNull($.l(V)), $.call(this.strIsFn(), this.item($, $.l(SP), $.add($.l(I), $.i(1))), $.l(V))))), () => {
          $.if($.ne($.l(W), $.l(I)), () => {
            this.setItem($, $.l(SP), $.l(W), this.item($, $.l(SP), $.l(I)));
            this.setItem($, $.l(SP), $.add($.l(W), $.i(1)), this.item($, $.l(SP), $.add($.l(I), $.i(1))));
          });
          $.put(W, $.add($.l(W), $.i(2)));
        });
        $.put(I, $.add($.l(I), $.i(2)));
      });
      $.set(this.spType(), SP_N, $.l(SP), $.l(W));
      $.run(this.spSyncFn(), $.l(SP));
    });
  }

  /** The index of the first pair named `name` (and valued `value` unless
   * null), or -1. */
  spFindFn(): number {
    return this.fn("spFind", [this.spRef(), this.sRef, this.sRef], [I32], (f, $) => {
      const [SP, K0, V0] = [0, 1, 2];
      const K = f.local(this.sRef);
      const V = f.local(this.sRef);
      const I = f.local(I32);
      $.put(K, $.call(this.wellFormedFn(), $.l(K0)));
      $.if($.notNull($.l(V0)), () => $.put(V, $.call(this.wellFormedFn(), $.l(V0))));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.get(this.spType(), SP_N, $.l(SP))), () => {
        $.if($.andThen($.call(this.strIsFn(), this.item($, $.l(SP), $.l(I)), $.l(K)), $.orElse($.isNull($.l(V)), $.call(this.strIsFn(), this.item($, $.l(SP), $.add($.l(I), $.i(1))), $.l(V)))), () => $.ret($.l(I)));
        $.put(I, $.add($.l(I), $.i(2)));
      });
      $.do($.i(-1));
    });
  }

  /** get(name): the value, or null */
  spGetFn(): number {
    return this.fn("spGet", [this.spRef(), this.sRef], [this.sRef], (f, $) => {
      const I = f.local(I32);
      $.put(I, $.call(this.spFindFn(), $.l(0), $.l(1), $.nul(this.S)));
      $.if($.lt($.l(I), $.i(0)), () => $.ret($.nul(this.S)));
      $.do(this.item($, $.l(0), $.add($.l(I), $.i(1))));
    });
  }

  /** getAll(name) as a string[] */
  spGetAllFn(): number {
    const vi = this.deps.strVec();
    return this.fn("spGetAll", [this.spRef(), this.sRef], [this.ref(vi.struct)], (f, $) => {
      const [SP, K0] = [0, 1];
      const K = f.local(this.sRef);
      const R = f.local(this.ref(this.listT));
      const I = f.local(I32);
      const C = f.local(I32);
      $.put(K, $.call(this.wellFormedFn(), $.l(K0)));
      $.put(R, $.anew(this.listT, $.get(this.spType(), SP_N, $.l(SP))));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.get(this.spType(), SP_N, $.l(SP))), () => {
        $.if($.call(this.strIsFn(), this.item($, $.l(SP), $.l(I)), $.l(K)), () => {
          $.aset(this.listT, $.l(R), $.l(C), this.item($, $.l(SP), $.add($.l(I), $.i(1))));
          $.put(C, $.add($.l(C), $.i(1)));
        });
        $.put(I, $.add($.l(I), $.i(2)));
      });
      $.do($.new_(vi.struct, $.l(C), $.raw((c) => {
        c.localGet(R);
        c.refAsNonNull();
      })));
      void LEN;
      void BUF;
    });
  }

  /** a < b by UTF-16 code units: -1, 0, 1 */
  strCmpFn(): number {
    return this.fn("strCmp", [this.sRef, this.sRef], [I32], (f, $) => {
      const [A_, B_] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      const X1 = f.local(I32);
      const Y1 = f.local(I32);
      $.put(N, $.sel(I32, $.lt($.alen($.l(A_)), $.alen($.l(B_))), $.alen($.l(A_)), $.alen($.l(B_))));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(X1, $.agetU(this.S, $.l(A_), $.l(I)));
        $.put(Y1, $.agetU(this.S, $.l(B_), $.l(I)));
        $.if($.ne($.l(X1), $.l(Y1)), () => $.ret($.sel(I32, $.lt($.l(X1), $.l(Y1)), $.i(-1), $.i(1))));
      });
      $.do($.sub($.gt($.alen($.l(A_)), $.l(N)), $.gt($.alen($.l(B_)), $.l(N))));
    });
  }

  /** sort(): lib/internal/url.js's own algorithm — nothing for at most
   * one pair, a stable in-place insertion sort below 100 list entries
   * (names and values counted together), a bottom-up stable merge sort
   * from 100 — comparing names by UTF-16 code units. */
  spSortFn(): number {
    return this.fn("spSort", [this.spRef()], [], (f, $) => {
      const SP = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const J = f.local(I32);
      const CK = f.local(this.sRef);
      const CV = f.local(this.sRef);
      const GO = f.local(I32);
      const STEP = f.local(I32);
      const START = f.local(I32);
      const MID = f.local(I32);
      const END = f.local(I32);
      const LB = f.local(this.ref(this.listT));
      const RB = f.local(this.ref(this.listT));
      $.put(N, $.get(this.spType(), SP_N, $.l(SP)));
      $.if($.le($.l(N), $.i(2)), () => {
        // Nothing needs to be done.
      }, () => $.if($.lt($.l(N), $.i(100)), () => {
        $.put(I, $.i(2));
        $.while($.lt($.l(I), $.l(N)), () => {
          $.put(CK, this.item($, $.l(SP), $.l(I)));
          $.put(CV, this.item($, $.l(SP), $.add($.l(I), $.i(1))));
          $.put(J, $.sub($.l(I), $.i(2)));
          $.put(GO, $.i(1));
          $.while($.both($.l(GO), $.ge($.l(J), $.i(0))), () => {
            $.if($.gt($.call(this.strCmpFn(), this.item($, $.l(SP), $.l(J)), $.l(CK)), $.i(0)), () => {
              this.setItem($, $.l(SP), $.add($.l(J), $.i(2)), this.item($, $.l(SP), $.l(J)));
              this.setItem($, $.l(SP), $.add($.l(J), $.i(3)), this.item($, $.l(SP), $.add($.l(J), $.i(1))));
              $.put(J, $.sub($.l(J), $.i(2)));
            }, () => $.put(GO, $.i(0)));
          });
          this.setItem($, $.l(SP), $.add($.l(J), $.i(2)), $.l(CK));
          this.setItem($, $.l(SP), $.add($.l(J), $.i(3)), $.l(CV));
          $.put(I, $.add($.l(I), $.i(2)));
        });
      }, () => {
        // Bottom-up iterative stable merge sort
        $.put(LB, $.anew(this.listT, $.l(N)));
        $.put(RB, $.anew(this.listT, $.l(N)));
        $.put(STEP, $.i(2));
        $.while($.lt($.l(STEP), $.l(N)), () => {
          $.put(START, $.i(0));
          $.while($.lt($.l(START), $.sub($.l(N), $.i(2))), () => {
            $.put(MID, $.add($.l(START), $.l(STEP)));
            $.put(END, $.add($.l(MID), $.l(STEP)));
            $.if($.ge($.l(END), $.l(N)), () => $.put(END, $.l(N)));
            $.if($.le($.l(MID), $.l(END)), () => {
              $.run(this.spMergeFn(), $.get(this.spType(), SP_LIST, $.l(SP)), $.l(START), $.l(MID), $.l(END), $.l(LB), $.l(RB));
            });
            $.put(START, $.add($.l(START), $.mul($.i(2), $.l(STEP))));
          });
          $.put(STEP, $.mul($.l(STEP), $.i(2)));
        });
      }));
      $.run(this.spSyncFn(), $.l(SP));
    });
  }

  /** lib/internal/url.js merge(out, start, mid, end, lBuffer, rBuffer) */
  private spMergeFn(): number {
    const L = this.ref(this.listT);
    return this.fn("spMerge", [L, I32, I32, I32, L, L], [], (f, $) => {
      const [OUT, START, MID, END, LB, RB] = [0, 1, 2, 3, 4, 5];
      const SL = f.local(I32);
      const SR = f.local(I32);
      const LI = f.local(I32);
      const RI = f.local(I32);
      const O = f.local(I32);
      const T = this.listT;
      const take = (buf: number, idx: number): void => {
        $.aset(T, $.l(OUT), $.l(O), $.aget(T, $.l(buf), $.l(idx)));
        $.put(O, $.add($.l(O), $.i(1)));
        $.put(idx, $.add($.l(idx), $.i(1)));
      };
      $.put(SL, $.sub($.l(MID), $.l(START)));
      $.put(SR, $.sub($.l(END), $.l(MID)));
      $.do($.l(LB), $.i(0), $.l(OUT), $.l(START), $.l(SL));
      $.c.arrayCopy(T, T);
      $.do($.l(RB), $.i(0), $.l(OUT), $.l(MID), $.l(SR));
      $.c.arrayCopy(T, T);
      $.put(O, $.l(START));
      $.while($.both($.lt($.l(LI), $.l(SL)), $.lt($.l(RI), $.l(SR))), () => {
        $.if($.le($.call(this.strCmpFn(), $.flat(this.S, $.aget(T, $.l(LB), $.l(LI))), $.flat(this.S, $.aget(T, $.l(RB), $.l(RI)))), $.i(0)), () => {
          take(LB, LI);
          take(LB, LI);
        }, () => {
          take(RB, RI);
          take(RB, RI);
        });
      });
      $.while($.lt($.l(LI), $.l(SL)), () => take(LB, LI));
      $.while($.lt($.l(RI), $.l(SR)), () => take(RB, RI));
    });
  }

  spSizeFn(): number {
    return this.fn("spSize", [this.spRef()], [I32], (_f, $) => {
      $.do($.shrU($.get(this.spType(), SP_N, $.l(0)), $.i(1)));
    });
  }
  /** keyAt / valAt (the for-of / forEach index reads) */
  spAtFn(val: boolean): number {
    return this.fn(val ? "spValAt" : "spKeyAt", [this.spRef(), I32], [this.sRef], (_f, $) => {
      $.do(this.item($, $.l(0), $.add($.mul($.l(1), $.i(2)), $.i(val ? 1 : 0))));
    });
  }

  /** new URLSearchParams(string[][]) */
  spFromPairsFn(): number {
    const outer = this.deps.strVecVec();
    const inner = this.deps.strVec();
    return this.fn("spFromPairs", [this.ref(outer.struct)], [this.spRef()], (f, $) => {
      const VV = 0;
      const SP = f.local(this.spRef());
      const I = f.local(I32);
      const ROW = f.local(this.ref(inner.struct));
      $.put(SP, $.call(this.spNewFn()));
      $.for(I, $.i(0), $.get(outer.struct, LEN, $.l(VV)), () => {
        $.put(ROW, $.cast(inner.struct, $.aget(outer.bufType, $.get(outer.struct, BUF, $.l(VV)), $.l(I))));
        $.if($.ne($.get(inner.struct, LEN, $.l(ROW)), $.i(2)), () => {
          this.throwType($, "Each query pair must be an iterable [name, value] tuple", "ERR_INVALID_TUPLE");
          $.ret($.nul(this.spType()));
        });
        $.run(this.spPushFn(), $.l(SP), $.call(this.wellFormedFn(), $.flat(this.S, $.aget(inner.bufType, $.get(inner.struct, BUF, $.l(ROW)), $.i(0)))));
        $.run(this.spPushFn(), $.l(SP), $.call(this.wellFormedFn(), $.flat(this.S, $.aget(inner.bufType, $.get(inner.struct, BUF, $.l(ROW)), $.i(1)))));
      });
      $.do($.l(SP));
    });
  }

  /* ── file URLs (getPathFromURLPosix, pathToFileURL) ───────────────── */

  /** fileURLToPath(url) on posix; errors pending (and null) on failure. */
  fileToPathFn(): number {
    return this.fn("fileToPath", [this.urlRef()], [this.sRef], (f, $) => {
      const U = 0;
      const P = f.local(this.sRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const PCT = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(P), i);
      $.if($.ne($.get(this.urlType(), U_TYPE, $.l(U)), $.i(T_FILE)), () => {
        this.throwType($, "The URL must be of scheme file", "ERR_INVALID_URL_SCHEME");
        $.ret($.nul(this.S));
      });
      $.if($.gt($.alen($.call(this.hostnameFn(), $.l(U))), $.i(0)), () => {
        this.throwType($, 'File URL host must be "localhost" or empty on linux', "ERR_INVALID_FILE_URL_HOST");
        $.ret($.nul(this.S));
      });
      $.put(P, $.get(this.urlType(), U_PATH, $.l(U)));
      $.put(N, $.alen($.l(P)));
      $.for(I, $.i(0), $.l(N), () => {
        $.if($.eq(cu($.l(I)), $.i(37)), () => {
          $.put(PCT, $.i(1));
          $.if($.andThen($.lt($.add($.l(I), $.i(2)), $.l(N)), $.both($.eq(cu($.add($.l(I), $.i(1))), $.i(50)), $.eq($.or(cu($.add($.l(I), $.i(2))), $.i(0x20)), $.i(102)))), () => {
            this.throwType($, "File URL path must not include encoded / characters", "ERR_INVALID_FILE_URL_PATH");
            $.ret($.nul(this.S));
          });
        });
      });
      $.if($.l(PCT), () => $.ret($.call(this.deps.decodeUriComponent(), $.l(P))));
      $.do($.l(P));
    });
  }

  /** fileURLToPath(string) */
  fileStrToPathFn(): number {
    return this.fn("fileStrToPath", [this.sRef], [this.sRef], (f, $) => {
      const U = f.local(this.urlRef());
      $.put(U, $.call(this.newFn(), $.l(0)));
      $.if($.isNull($.l(U)), () => $.ret($.nul(this.S)));
      $.do($.call(this.fileToPathFn(), $.l(U)));
    });
  }

  /** pathToFileURL(path) on posix (node_url.cc EncodePathChars over the
   * resolved path's UTF-8). */
  pathToFileFn(): number {
    return this.fn("pathToFile", [this.sRef], [this.urlRef()], (f, $) => {
      const P = 0;
      const R = f.local(this.sRef);
      const BY = f.local(this.bRef);
      const O = f.local(this.obRef);
      const I = f.local(I32);
      const B = f.local(I32);
      const U = f.local(this.urlRef());
      $.put(R, $.call(this.deps.resolve1(), $.l(P)));
      $.if($.andThen($.gt($.alen($.l(P)), $.i(0)), $.eq($.agetU(this.S, $.l(P), $.sub($.alen($.l(P)), $.i(1))), $.i(47))), () => {
        $.if($.orElse($.not($.alen($.l(R))), $.ne($.agetU(this.S, $.l(R), $.sub($.alen($.l(R)), $.i(1))), $.i(47))), () => {
          $.put(R, $.call(this.concat1Fn(), $.l(R)));
        });
      });
      $.put(BY, $.call(this.utf8Fn(), $.l(R)));
      $.put(O, this.obNew($));
      this.pushLit($, $.l(O), "file://");
      const enc: [string, string][] = [["\0", "%00"], ["\t", "%09"], ["\n", "%0A"], ["\r", "%0D"], [" ", "%20"], ['"', "%22"], ["#", "%23"], ["%", "%25"], ["?", "%3F"], ["[", "%5B"], ["\\", "%5C"], ["]", "%5D"], ["^", "%5E"], ["|", "%7C"], ["~", "%7E"]];
      $.for(I, $.i(0), $.alen($.l(BY)), () => {
        $.put(B, this.u8($, $.l(BY), $.l(I)));
        let chain = (): void => this.push($, $.l(O), $.l(B));
        for (const [c, e] of enc.slice().reverse()) {
          const next = chain;
          chain = () => $.if($.eq($.l(B), $.i(c.charCodeAt(0))), () => this.pushLit($, $.l(O), e), next);
        }
        chain();
      });
      $.put(U, $.call(this.parseFn(), $.call(this.obToBytesFn(), $.l(O))));
      $.if($.isNull($.l(U)), () => this.throwType($, "Invalid URL", "ERR_INVALID_URL"));
      $.do($.l(U));
    });
  }

  /** s + "/" */
  private concat1Fn(): number {
    return this.fn("slashAppend", [this.sRef], [this.sRef], (f, $) => {
      const R = f.local(this.sRef);
      $.put(R, $.anew(this.S, $.add($.alen($.l(0)), $.i(1))));
      $.do($.l(R), $.i(0), $.l(0), $.i(0), $.alen($.l(0)));
      $.c.arrayCopy(this.S, this.S);
      $.aset(this.S, $.l(R), $.alen($.l(0)), $.i(47));
      $.do($.l(R));
    });
  }

  /* ── the http client's URL argument (_http_client.js) ─────────────── */

  /** `new URL(input)` then urlToHttpOptions's decodeURIComponent of the
   * credentials, then ClientRequest's protocol check against http:'s
   * agent — each failure pending in Node's order (null). */
  httpTargetFn(secure = false): number {
    // INC-29 U4: https's (secure) expects "https:".
    return this.fn(secure ? "httpsTarget" : "httpTarget", [this.sRef], [this.urlRef()], (f, $) => {
      const U = f.local(this.urlRef());
      const O = f.local(this.obRef);
      const g = (i: number): X => $.get(this.urlType(), i, $.l(U));
      $.put(U, $.call(this.newFn(), $.l(0)));
      $.if($.isNull($.l(U)), () => $.ret($.nul(this.urlType())));
      $.if($.either($.gt($.alen(g(U_USER)), $.i(0)), $.gt($.alen(g(U_PASS)), $.i(0))), () => {
        $.drop($.call(this.deps.decodeUriComponent(), g(U_USER)));
        $.if(this.pending($), () => $.ret($.nul(this.urlType())));
        $.drop($.call(this.deps.decodeUriComponent(), g(U_PASS)));
        $.if(this.pending($), () => $.ret($.nul(this.urlType())));
      });
      $.if($.ne(g(U_TYPE), $.i(secure ? T_HTTPS : T_HTTP)), () => {
        $.put(O, this.obNew($));
        this.pushLit($, $.l(O), 'Protocol "');
        $.run(this.obAppendStrFn(), $.l(O), g(U_SCHEME));
        this.pushLit($, $.l(O), secure ? ':" not supported. Expected "https:"' : ':" not supported. Expected "http:"');
        this.deps.setCellError($.c, "%TypeError", "TypeError", (c) => {
          c.localGet(O);
          c.call(this.obToStrFn());
        }, "ERR_INVALID_PROTOCOL");
        $.ret($.nul(this.urlType()));
      });
      $.do($.l(U));
    });
  }

  /** options.hostname: the hostname, IPv6 brackets stripped */
  httpHostFn(): number {
    return this.fn("httpHost", [this.urlRef()], [this.sRef], (f, $) => {
      const H = f.local(this.sRef);
      const R = f.local(this.sRef);
      $.put(H, $.call(this.hostnameFn(), $.l(0)));
      $.if($.andThen($.gt($.alen($.l(H)), $.i(0)), $.eq($.agetU(this.S, $.l(H), $.i(0)), $.i(91))), () => {
        $.put(R, $.anew(this.S, $.sub($.alen($.l(H)), $.i(2))));
        $.do($.l(R), $.i(0), $.l(H), $.i(1), $.sub($.alen($.l(H)), $.i(2)));
        $.c.arrayCopy(this.S, this.S);
        $.ret($.l(R));
      });
      $.do($.l(H));
    });
  }

  /** options.port (0 = none) */
  httpPortFn(): number {
    return this.fn("httpPort", [this.urlRef()], [F64], (_f, $) => {
      const p = $.get(this.urlType(), U_PORT, $.l(0));
      $.do($.sel(F64, $.lt(p, $.i(0)), $.d(0), $.i2d(p)));
    });
  }

  /** options.path: pathname + search */
  httpPathFn(): number {
    return this.fn("httpPath", [this.urlRef()], [this.sRef], (f, $) => {
      const O = f.local(this.obRef);
      $.put(O, this.obNew($));
      $.run(this.obAppendStrFn(), $.l(O), $.call(this.pathnameFn(), $.l(0)));
      $.run(this.obAppendStrFn(), $.l(O), $.call(this.searchFn(), $.l(0)));
      $.do(this.obStr($, $.l(O)));
    });
  }

  /** base64(UTF-8(decode(username) + ":" + decode(password))), or null
   * without credentials (the decodes cannot fail after httpTarget). */
  httpAuthFn(): number {
    return this.fn("httpAuth", [this.urlRef()], [this.sRef], (f, $) => {
      const U = 0;
      const UB = f.local(this.ubRef);
      const S = f.local(this.sRef);
      const BY = f.local(this.bRef);
      const O = f.local(this.obRef);
      const I = f.local(I32);
      const N = f.local(I32);
      const V = f.local(I32);
      const g = (i: number): X => $.get(this.urlType(), i, $.l(U));
      $.if($.not($.either($.gt($.alen(g(U_USER)), $.i(0)), $.gt($.alen(g(U_PASS)), $.i(0)))), () => $.ret($.nul(this.S)));
      $.put(UB, this.ubNew($));
      $.put(S, $.call(this.deps.decodeUriComponent(), g(U_USER)));
      $.run(this.ubAppendFn(), $.l(UB), $.l(S), $.i(0), $.alen($.l(S)));
      this.upush($, $.l(UB), $.i(58));
      $.put(S, $.call(this.deps.decodeUriComponent(), g(U_PASS)));
      $.run(this.ubAppendFn(), $.l(UB), $.l(S), $.i(0), $.alen($.l(S)));
      $.put(BY, $.call(this.utf8Fn(), $.call(this.ubToStrFn(), $.l(UB))));
      $.put(N, $.alen($.l(BY)));
      $.put(O, this.obNew($));
      const b64 = (v: X): X => {
        return $.sel(I32, $.lt(v, $.i(26)), $.add(v, $.i(65)), $.sel(I32, $.lt(v, $.i(52)), $.add(v, $.i(71)), $.sel(I32, $.lt(v, $.i(62)), $.sub(v, $.i(4)), $.sel(I32, $.eq(v, $.i(62)), $.i(43), $.i(47)))));
      };
      const byteAt = (k: X): X => $.sel(I32, $.lt(k, $.l(N)), this.u8($, $.l(BY), k), $.i(0));
      $.put(I, $.i(0));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(V, $.or($.or($.shl(byteAt($.l(I)), $.i(16)), $.shl(byteAt($.add($.l(I), $.i(1))), $.i(8))), byteAt($.add($.l(I), $.i(2)))));
        this.push($, $.l(O), b64($.and($.shrU($.l(V), $.i(18)), $.i(63))));
        this.push($, $.l(O), b64($.and($.shrU($.l(V), $.i(12)), $.i(63))));
        this.push($, $.l(O), $.sel(I32, $.lt($.add($.l(I), $.i(1)), $.l(N)), b64($.and($.shrU($.l(V), $.i(6)), $.i(63))), $.i(61)));
        this.push($, $.l(O), $.sel(I32, $.lt($.add($.l(I), $.i(2)), $.l(N)), b64($.and($.l(V), $.i(63))), $.i(61)));
        $.put(I, $.add($.l(I), $.i(3)));
      });
      $.do(this.obStr($, $.l(O)));
    });
  }
}
