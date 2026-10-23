/* node:querystring on the WasmGC tier: Node v24.18.1's lib/querystring.js
 * (parse, stringify, escape) and lib/internal/querystring.js (encodeStr),
 * built in the module with no host import. unescape is url-whatwg.ts's
 * qsUnescape, reused in place.
 *
 * PARSE is Node's interleaved sep/eq scan transcribed over the tier's
 * UTF-16 storage, which is Node's own unit of scanning: the naive
 * partial-match resets (an overlapping partial match is not re-examined),
 * the encodeCheck fast path (a key or value decodes only once a full
 * valid %XX has been seen in it), '+' as a space, empty segments that
 * still spend the maxKeys budget, and `pairs` held as an f64 so
 * Infinity, NaN and fractional budgets behave exactly as Node's. A
 * decode is qsUnescape (decodeURIComponent, else unescapeBuffer), which
 * never throws, so addKeyVal's catch is unreachable with the default
 * decoder. The result is the call site's dictionary record: a first value
 * is the union's string arm, a repeat replaces it IN PLACE with the
 * string[] arm (`obj[key] = [cur, v]` keeps the key's position) and later
 * repeats push onto that vector.
 *
 * Node's result has a null prototype, which a typed record cannot show.
 * The emitter refuses by name the three readers that would see the
 * difference (printing it, its ToString, and converting it to a dynamic
 * value) in modules that reach qs.parse.
 *
 * STRINGIFY walks a dynamic value: a non-object (or a function) is "",
 * anything else lists its own entries in JS order (Object.entries, so a
 * dynamic ARRAY stringifies by index, as in Node); an array value expands
 * to repeated keys and an empty one emits nothing; encodeStringified's
 * value rules (strings escape, finite numbers render then escape,
 * booleans are bare, everything else is the empty value).
 *
 * ESCAPE is encodeStr with qsEscape's noEscape table (the
 * encodeURIComponent unreserved set). Unlike encodeURIComponent it pairs
 * ANY surrogate with the unit after it without checking that unit, and
 * throws URIError [ERR_INVALID_URI] only when a surrogate is the last
 * unit of the string. */
import { A, Fn, type X } from "./asm.js";
import { F64, I32, type ModuleBuilder, type ValType } from "./module.js";
import type { Code } from "./code.js";
import type { UrlEngine } from "./url-whatwg.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, type DynBuilder } from "./dyn.js";

export interface QsDeps {
  strRef: () => ValType;
  strType: () => number;
  /** url-whatwg.ts: the UTF-16 buffer and qsUnescape. */
  url: () => UrlEngine;
  lit: (c: Code, s: string) => void;
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, codeLit: string | null) => void;
  /** The pending-exception kind global (nonzero = pending). */
  excKind: () => number;
  /** `(f64) -> str`, Number#toString. */
  f64ToStr: () => number;
  dyn: () => DynBuilder;
}

/** One qs.parse call site's dictionary record, as the emitter built its
 * types: the record struct (field 0 = the overflow map), the map's
 * helpers, the two union arm structs and the string[] vector's. */
export interface QsDict {
  /** Cache key (the record's typeKey). */
  key: string;
  dictStruct: number;
  mapRef: ValType;
  mapNew: number;
  /** (map, str) -> (i32 found, union) */
  mapGet: number;
  /** (map, str, union) -> () */
  mapSet: number;
  /** The union base struct (field 0 = tag) and its ref type. */
  unionBase: number;
  unionRef: ValType;
  strArm: number;
  strTag: number;
  arrArm: number;
  arrTag: number;
  vecRef: ValType;
  /** (f64) -> vec */
  vecNewLen: number;
  /** (vec, str) -> () */
  vecPush: number;
}

const PCT = 37;
const PLUS = 43;

export class QsBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: QsDeps,
  ) {}

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.qs.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private get S(): number {
    return this.deps.strType();
  }
  private get sRef(): ValType {
    return this.deps.strRef();
  }
  private get W(): UrlEngine {
    return this.deps.url();
  }
  private lit($: A, s: string): X {
    return $.raw((c) => this.deps.lit(c, s));
  }
  private isHex($: A, c: X): X {
    // isHexTable: 0-9 A-F a-f (code units past 255 are never hex)
    return $.either(
      $.leU($.sub(c, $.i(48)), $.i(9)),
      $.leU($.sub($.or(c, $.i(0x20)), $.i(97)), $.i(5)),
    );
  }
  private hexUpper($: A, n: X): X {
    return $.sel(I32, $.ltU(n, $.i(10)), $.add(n, $.i(48)), $.add(n, $.i(55)));
  }

  /* ── escape (encodeStr over qsEscape's noEscape table) ────────────── */

  /** noEscape: ALPHA / DIGIT / ! ' ( ) * - . _ ~ */
  private noEscapeFn(): number {
    return this.fn("noEscape", [I32], [I32], (_f, $) => {
      const C = 0;
      $.do(
        $.either(
          $.either($.leU($.sub($.or($.l(C), $.i(0x20)), $.i(97)), $.i(25)), $.leU($.sub($.l(C), $.i(48)), $.i(9))),
          $.either(
            $.either($.eq($.l(C), $.i(33)), $.leU($.sub($.l(C), $.i(39)), $.i(3))),
            $.either(
              $.either($.eq($.l(C), $.i(45)), $.eq($.l(C), $.i(46))),
              $.either($.eq($.l(C), $.i(95)), $.eq($.l(C), $.i(126))),
            ),
          ),
        ),
      );
    });
  }

  /** `(ub, str) -> i32`: ub += encodeStr(str); 0 when it threw (the
   * URIError is pending). */
  encodeIntoFn(): number {
    const W = this.W;
    return this.fn("encodeInto", [W.ubRef, this.sRef], [I32], (f, $) => {
      const [O, STR] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      const C = f.local(I32);
      const cu = (i: X): X => $.agetU(this.S, $.l(STR), i);
      const push = (v: X): void => $.run(W.ubPushFn(), $.l(O), v);
      const hex = (b: X): void => {
        push($.i(PCT));
        push(this.hexUpper($, $.shrU(b, $.i(4))));
        push(this.hexUpper($, $.and(b, $.i(15))));
      };
      $.put(N, $.alen($.l(STR)));
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu($.l(I)));
        $.if($.lt($.l(C), $.i(0x80)), () => {
          $.if($.call(this.noEscapeFn(), $.l(C)), () => push($.l(C)), () => hex($.l(C)));
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
              // Any surrogate takes the next unit as its pair, unchecked.
              $.put(I, $.add($.l(I), $.i(1)));
              $.if($.ge($.l(I), $.l(N)), () => {
                this.deps.setCellError($.c, "%Error", "URIError", (c) => this.deps.lit(c, "URI malformed"), "ERR_INVALID_URI");
                $.ret($.i(0));
              });
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
      $.do($.i(1));
    });
  }

  /** `(str) -> str` querystring.escape; null with the URIError pending. */
  escapeFn(): number {
    const W = this.W;
    return this.fn("escape", [this.sRef], [this.sRef], (f, $) => {
      const O = f.local(W.ubRef);
      $.put(O, W.ubNew($));
      $.if($.not($.call(this.encodeIntoFn(), $.l(O), $.l(0))), () => $.ret($.nul(this.S)));
      $.do($.call(W.ubToStrFn(), $.l(O)));
    });
  }

  /** `(str) -> str` querystring.unescape (never throws). */
  unescapeFn(): number {
    return this.W.qsUnescapeFn();
  }

  /* ── parse ────────────────────────────────────────────────────────── */

  /** addKeyVal(obj, key, value, keyEncoded, valEncoded) */
  private addFn(d: QsDict): number {
    return this.fn(`add:${d.key}`, [d.mapRef, this.sRef, this.sRef, I32, I32], [], (f, $) => {
      const [M, K, V, KE, VE] = [0, 1, 2, 3, 4];
      const FOUND = f.local(I32);
      const CUR = f.local(d.unionRef);
      const VEC = f.local(d.vecRef);
      $.if($.both($.gtU($.alen($.l(K)), $.i(0)), $.l(KE)), () => $.put(K, $.call(this.unescapeFn(), $.l(K))));
      $.if($.both($.gtU($.alen($.l(V)), $.i(0)), $.l(VE)), () => $.put(V, $.call(this.unescapeFn(), $.l(V))));
      $.do($.l(M), $.l(K));
      $.c.call(d.mapGet);
      $.c.localSet(CUR);
      $.c.localSet(FOUND);
      $.if($.not($.l(FOUND)), () => {
        $.run(d.mapSet, $.l(M), $.l(K), $.new_(d.strArm, $.i(d.strTag), $.l(V)));
        $.ret();
      });
      $.if($.eq($.get(d.unionBase, 0, $.l(CUR)), $.i(d.strTag)), () => {
        // obj[key] = [curValue, value]
        $.put(VEC, $.call(d.vecNewLen, $.d(0)));
        $.run(d.vecPush, $.l(VEC), $.get(d.strArm, 1, $.cast(d.strArm, $.l(CUR))));
        $.run(d.vecPush, $.l(VEC), $.l(V));
        $.run(d.mapSet, $.l(M), $.l(K), $.new_(d.arrArm, $.i(d.arrTag), $.l(VEC)));
      }, () => {
        $.run(d.vecPush, $.get(d.arrArm, 1, $.cast(d.arrArm, $.l(CUR))), $.l(V));
      });
    });
  }

  /** `(qs, sep, eq, maxKeys) -> dict` querystring.parse. */
  parseFn(d: QsDict): number {
    const W = this.W;
    const dictRef: ValType = { kind: "ref", nullable: true, typeIndex: d.dictStruct };
    return this.fn(`parse:${d.key}`, [this.sRef, this.sRef, this.sRef, F64], [dictRef], (f, $) => {
      const [QS, SEP, EQ, MAXK] = [0, 1, 2, 3];
      const OBJ = f.local(dictRef);
      const MAP = f.local(d.mapRef);
      const SL = f.local(I32);
      const EL = f.local(I32);
      const PAIRS = f.local(F64);
      const N = f.local(I32);
      const I = f.local(I32);
      const C = f.local(I32);
      const LP = f.local(I32);
      const SI = f.local(I32);
      const EI = f.local(I32);
      const END = f.local(I32);
      const KEY = f.local(W.ubRef);
      const VAL = f.local(W.ubRef);
      const KE = f.local(I32);
      const VE = f.local(I32);
      const EC = f.local(I32);
      const SKIP = f.local(I32);
      const cu = (s: number, i: X): X => $.agetU(this.S, $.l(s), i);
      const app = (buf: number, from: X, to: X): void => $.run(W.ubAppendFn(), $.l(buf), $.l(QS), from, to);
      const add = (): void =>
        $.run(this.addFn(d), $.l(MAP), $.call(W.ubToStrFn(), $.l(KEY)), $.call(W.ubToStrFn(), $.l(VAL)), $.l(KE), $.l(VE));
      // if (--pairs === 0) return obj;
      const spend = (): void => {
        $.put(PAIRS, $.dsub($.l(PAIRS), $.d(1)));
        $.if($.deq($.l(PAIRS), $.d(0)), () => $.ret($.l(OBJ)));
      };

      $.put(MAP, $.call(d.mapNew));
      $.c.structNewDefault(d.dictStruct);
      $.c.localSet(OBJ);
      $.set(d.dictStruct, 0, $.l(OBJ), $.l(MAP)); // no declared fields: the overflow map is field 0
      $.put(N, $.alen($.l(QS)));
      $.if($.not($.l(N)), () => $.ret($.l(OBJ)));
      // `!sep` / `!eq`: an empty string is the default too
      $.if($.not($.alen($.l(SEP))), () => $.put(SEP, this.lit($, "&")));
      $.if($.not($.alen($.l(EQ))), () => $.put(EQ, this.lit($, "=")));
      $.put(SL, $.alen($.l(SEP)));
      $.put(EL, $.alen($.l(EQ)));
      $.put(PAIRS, $.sel(F64, $.dgt($.l(MAXK), $.d(0)), $.l(MAXK), $.d(-1)));
      $.put(KEY, W.ubNew($));
      $.put(VAL, W.ubNew($));

      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(C, cu(QS, $.l(I)));
        $.if($.eq($.l(C), cu(SEP, $.l(SI))), () => {
          $.put(SI, $.add($.l(SI), $.i(1)));
          $.if($.eq($.l(SI), $.l(SL)), () => {
            // Key/value pair separator match.
            $.put(END, $.add($.sub($.l(I), $.l(SI)), $.i(1)));
            $.put(SKIP, $.i(0));
            $.if($.lt($.l(EI), $.l(EL)), () => {
              // No (entire) key/value separator seen.
              $.if($.lt($.l(LP), $.l(END)), () => app(KEY, $.l(LP), $.l(END)), () => {
                $.if($.not(W.ubLen($, $.l(KEY))), () => {
                  // An empty substring between separators.
                  spend();
                  $.put(LP, $.add($.l(I), $.i(1)));
                  $.put(SI, $.i(0));
                  $.put(EI, $.i(0));
                  $.put(SKIP, $.i(1));
                });
              });
            }, () => {
              $.if($.lt($.l(LP), $.l(END)), () => app(VAL, $.l(LP), $.l(END)));
            });
            $.if($.not($.l(SKIP)), () => {
              add();
              spend();
              $.put(KE, $.i(0));
              $.put(VE, $.i(0));
              $.put(KEY, W.ubNew($));
              $.put(VAL, W.ubNew($));
              $.put(EC, $.i(0));
              $.put(LP, $.add($.l(I), $.i(1)));
              $.put(SI, $.i(0));
              $.put(EI, $.i(0));
            });
          });
        }, () => {
          $.put(SI, $.i(0));
          // SKIP stands for the source's `continue`
          $.put(SKIP, $.i(0));
          // Try matching the key/value separator if we haven't yet.
          $.if($.lt($.l(EI), $.l(EL)), () => {
            $.if($.eq($.l(C), cu(EQ, $.l(EI))), () => {
              $.put(EI, $.add($.l(EI), $.i(1)));
              $.if($.eq($.l(EI), $.l(EL)), () => {
                // Key/value separator match.
                $.put(END, $.add($.sub($.l(I), $.l(EI)), $.i(1)));
                $.if($.lt($.l(LP), $.l(END)), () => app(KEY, $.l(LP), $.l(END)));
                $.put(EC, $.i(0));
                $.put(LP, $.add($.l(I), $.i(1)));
              });
              $.put(SKIP, $.i(1));
            }, () => {
              $.put(EI, $.i(0));
              $.if($.not($.l(KE)), () => {
                // Match a valid encoded byte once to minimize decode calls.
                $.if($.eq($.l(C), $.i(PCT)), () => {
                  $.put(EC, $.i(1));
                  $.put(SKIP, $.i(1));
                }, () => {
                  $.if($.gt($.l(EC), $.i(0)), () => {
                    $.if(this.isHex($, $.l(C)), () => {
                      $.put(EC, $.add($.l(EC), $.i(1)));
                      $.if($.eq($.l(EC), $.i(3)), () => $.put(KE, $.i(1)));
                      $.put(SKIP, $.i(1));
                    }, () => $.put(EC, $.i(0)));
                  });
                });
              });
              $.if($.both($.not($.l(SKIP)), $.eq($.l(C), $.i(PLUS))), () => {
                $.if($.lt($.l(LP), $.l(I)), () => app(KEY, $.l(LP), $.l(I)));
                $.run(W.ubPushFn(), $.l(KEY), $.i(32));
                $.put(LP, $.add($.l(I), $.i(1)));
                $.put(SKIP, $.i(1));
              });
            });
          });
          $.if($.not($.l(SKIP)), () => {
            $.if($.eq($.l(C), $.i(PLUS)), () => {
              $.if($.lt($.l(LP), $.l(I)), () => app(VAL, $.l(LP), $.l(I)));
              $.run(W.ubPushFn(), $.l(VAL), $.i(32));
              $.put(LP, $.add($.l(I), $.i(1)));
            }, () => {
              $.if($.not($.l(VE)), () => {
                $.if($.eq($.l(C), $.i(PCT)), () => $.put(EC, $.i(1)), () => {
                  $.if($.gt($.l(EC), $.i(0)), () => {
                    $.if(this.isHex($, $.l(C)), () => {
                      $.put(EC, $.add($.l(EC), $.i(1)));
                      $.if($.eq($.l(EC), $.i(3)), () => $.put(VE, $.i(1)));
                    }, () => $.put(EC, $.i(0)));
                  });
                });
              });
            });
          });
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });

      // Deal with any leftover key or value data.
      $.if($.lt($.l(LP), $.l(N)), () => {
        $.if($.lt($.l(EI), $.l(EL)), () => app(KEY, $.l(LP), $.l(N)), () => {
          $.if($.lt($.l(SI), $.l(SL)), () => app(VAL, $.l(LP), $.l(N)));
        });
      }, () => {
        // We ended on an empty substring.
        $.if($.both($.not($.l(EI)), $.not(W.ubLen($, $.l(KEY)))), () => $.ret($.l(OBJ)));
      });
      add();
      $.do($.l(OBJ));
    });
  }

  /* ── stringify ────────────────────────────────────────────────────── */

  /** `(ub, dyn) -> i32` ub += encodeStringified(v); 0 when it threw. */
  private valueIntoFn(): number {
    const W = this.W;
    const dyn = this.deps.dyn();
    return this.fn("valueInto", [W.ubRef, dyn.dynRef()], [I32], (f, $) => {
      const [O, V] = [0, 1];
      const K = f.local(I32);
      const str = (s: X): X => $.call(this.encodeIntoFn(), $.l(O), s);
      $.put(K, $.get(dyn.dynT(), DYN_KIND, $.l(V)));
      $.if($.eq($.l(K), $.i(DK.STR)), () => $.ret(str($.cast(this.S, $.get(dyn.dynT(), DYN_REF, $.l(V))))));
      $.if($.eq($.l(K), $.i(DK.NUM)), () => {
        // NumberIsFinite: v - v === 0
        $.if($.deq($.dsub($.get(dyn.dynT(), DYN_NUM, $.l(V)), $.get(dyn.dynT(), DYN_NUM, $.l(V))), $.d(0)), () =>
          $.ret(str($.call(this.deps.f64ToStr(), $.get(dyn.dynT(), DYN_NUM, $.l(V))))));
        $.ret($.i(1));
      });
      $.if($.eq($.l(K), $.i(DK.BOOL)), () => {
        const word = (w: string): void => $.run(W.ubAppendFn(), $.l(O), this.lit($, w), $.i(0), $.i(w.length));
        $.if($.dne($.get(dyn.dynT(), DYN_NUM, $.l(V)), $.d(0)), () => word("true"), () => word("false"));
        $.ret($.i(1));
      });
      $.do($.i(1));
    });
  }

  /** `(dyn, sep, eq) -> str` querystring.stringify; null with an error
   * pending. */
  stringifyFn(): number {
    const W = this.W;
    const dyn = this.deps.dyn();
    const dynT = dyn.dynT();
    return this.fn("stringify", [dyn.dynRef(), this.sRef, this.sRef], [this.sRef], (f, $) => {
      const [OBJ, SEP, EQ] = [0, 1, 2];
      const K = f.local(I32);
      const ENTS = f.local(dyn.dynRef());
      const N = f.local(I32);
      const I = f.local(I32);
      const PAIR = f.local(dyn.dynRef());
      const KS = f.local(this.sRef);
      const V = f.local(dyn.dynRef());
      const VN = f.local(I32);
      const J = f.local(I32);
      const O = f.local(W.ubRef);
      const KB = f.local(W.ubRef);
      const arrLen = (d: X): X => $.raw((c) => dyn.arrLen(c, () => dyn.arrPayload(c, () => d())));
      const arrAt = (d: X, i: X): X => $.raw((c) => dyn.arrAt(c, () => dyn.arrPayload(c, () => d()), () => i()));
      const fail = (): void => $.ret($.nul(this.S));
      const appendStr = (s: X): void => $.run(W.ubAppendFn(), $.l(O), s, $.i(0), $.alen(s));
      const field = (val: X): void => {
        appendStr($.l(KS));
        $.if($.not($.call(this.valueIntoFn(), $.l(O), val)), fail);
      };
      $.if($.not($.alen($.l(SEP))), () => $.put(SEP, this.lit($, "&")));
      $.if($.not($.alen($.l(EQ))), () => $.put(EQ, this.lit($, "=")));
      $.put(K, $.get(dynT, DYN_KIND, $.l(OBJ)));
      // obj !== null && typeof obj === 'object'
      $.if(
        $.either(
          $.either($.either($.eq($.l(K), $.i(DK.NULL)), $.eq($.l(K), $.i(DK.UNDEF))), $.either($.eq($.l(K), $.i(DK.BOOL)), $.eq($.l(K), $.i(DK.NUM)))),
          $.either($.eq($.l(K), $.i(DK.STR)), $.eq($.l(K), $.i(DK.FUNC))),
        ),
        () => $.ret($.anew(this.S, $.i(0))),
      );
      $.put(ENTS, $.call(dyn.objWalk(), $.l(OBJ), $.i(2)));
      $.if($.ne($.g(this.deps.excKind()), $.i(0)), fail);
      $.put(O, W.ubNew($));
      $.put(N, arrLen($.l(ENTS)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(PAIR, arrAt($.l(ENTS), $.l(I)));
        // ks = convert(k, encode) + eq
        $.put(KB, W.ubNew($));
        $.if($.not($.call(this.encodeIntoFn(), $.l(KB), $.cast(this.S, $.get(dynT, DYN_REF, arrAt($.l(PAIR), $.i(0)))))), fail);
        $.run(W.ubAppendFn(), $.l(KB), $.l(EQ), $.i(0), $.alen($.l(EQ)));
        $.put(KS, $.call(W.ubToStrFn(), $.l(KB)));
        $.put(V, arrAt($.l(PAIR), $.i(1)));
        $.if($.eq($.get(dynT, DYN_KIND, $.l(V)), $.i(DK.ARR)), () => {
          $.put(VN, arrLen($.l(V)));
          $.if($.gt($.l(VN), $.i(0)), () => {
            $.if(W.ubLen($, $.l(O)), () => appendStr($.l(SEP)));
            $.for(J, $.i(0), $.l(VN), () => {
              $.if($.l(J), () => appendStr($.l(SEP)));
              field(arrAt($.l(V), $.l(J)));
            });
          });
        }, () => {
          $.if(W.ubLen($, $.l(O)), () => appendStr($.l(SEP)));
          field($.l(V));
        });
      });
      $.do($.call(W.ubToStrFn(), $.l(O)));
    });
  }
}
