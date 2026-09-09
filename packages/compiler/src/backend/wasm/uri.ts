/* INC-25 pass P5 — the "str.*" IR-key family: the URI component codecs
 * and (D5) the WHATWG base64 globals. A structurally NEW subsystem (CP1
 * §8): the tier's first UTF-8 bridge with a THROW disposition, versus
 * typedarrays.ts's existing bridges, which are both lenient (%w.bytes.
 * fromStr:utf8 substitutes U+FFFD for a lone surrogate on encode;
 * %w.bytes.toStr:utf8 is the WHATWG maximal-subpart REPLACEMENT decode).
 * Neither is reused here — CP1 §5/§6 read both for STRUCTURE and found
 * the one branch that must differ (the lone-surrogate/malformed-input
 * disposition) sits exactly where reuse would have to widen an existing
 * `cached()` name with other live callers (the CACHED lesson, v6 §11.2).
 *
 * MEASURED, not transcribed (CP1 §3, the alphabet sweep, run BEFORE any
 * of this file existed): both encoders throw `URIError: "URI malformed"`
 * on EVERY lone-surrogate shape, identical text; decodeURIComponent
 * throws the SAME text on every malformed-escape/overlong/encoded-
 * surrogate/out-of-range/truncated row (CP1 addendum §E12 — three
 * independent instruments, rev's, the lead's, and this file's own,
 * agree). The unreserved sets (82 for encodeURI, 71 for
 * encodeURIComponent, delta exactly `#$&+,/:;=?@`) are likewise
 * measured, not copied from scr_string.c (whose LIVE implementation,
 * per CP1 addendum §B4/E11, is `scr_str_encode_uri_component` — the
 * dead `scr_encode_uri_component` at scr_string.c:1147 is board #130,
 * not this pass's to fix).
 *
 * THIS PASS OF THE FILE builds the ENCODE direction (percentEncode,
 * encodeUriComponent, encodeUri) and the two unreserved-set predicates
 * (baseUnreserved/extraReserved) fully, and is wired into emitter.ts's
 * P5 dispatch. decodeUriComponent and atob/btoa are the next unit of
 * work — not present in this file yet, so str.decodeUriComponent/
 * str.atob/str.btoa continue to refuse by name exactly as before this
 * pass, per rule 1 (never a silent miscompile: an unwired key must keep
 * refusing, not trap). */
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export interface UriDeps {
  strRef: () => ValType;
  strType: () => number;
  /** emitter.ts's emitSetCellError, the json.ts/url.ts precedent: the
   * caller here (a standalone interned helper, no `this.fn` walk state)
   * pushes its own return-type-correct placeholder and `return_()`s
   * itself immediately after — the outer real-function call site does
   * the pending-check-and-propagate half via emitPendingCheck(). */
  throwError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void) => void;
  /** Push an interned string literal. */
  lit: (c: Code, s: string) => void;
  /** url.ts's %w.url.hexVal(ch)->i32 (-1 on non-hex) — REUSED, not re-
   * derived (Q2, the LEAD's ruling — CP1 addendum §C; D4/D5 are Joe's
   * own rulings this pass, Q1-Q3 are the lead's): board #130 is a stale-twin
   * board about duplicated URI-encoder logic in the C lane, and minting
   * a second hex-nibble table here would reproduce that exact defect
   * shape in the wasm lane. url.ts's own `hexValHelper` was widened from
   * `private` to enable this. */
  hexVal: () => number;
  dynRef: () => ValType;
  /** %w.dyn.toStr(d)->str, the tier's ToString-of-a-dyn-value walker
   * (dyn.ts, "the C emitter's sc_ds walker"). D5's atob/btoa arguments
   * arrive as DYN — WebIDL ToString runs in the runtime over the dyn
   * kind (Node's own caller is literally `_atob(\`${input}\`)` — a
   * template literal, MEAS-11). Symbol has no DK kind at all (dyn.ts's
   * DK enum: NULL/BOOL/NUM/STR/ARR/OBJ/UNDEF/BYTES/FUNC/HANDLE/PROMISE/
   * JSVAL, twelve kinds, none of them SYMBOL — TWO SOURCES, not one:
   * this enumeration, read directly, AND dyn.ts's own pre-existing
   * comment at ~L4323, predating this pass: "`bigint` and `symbol` have
   * no DK kind at all (this tier boxes neither), so no dyn value can
   * ever carry one in") — so MEAS-11's "atob(Symbol()) throws before
   * atob is entered" row cannot arise as a DYN argument on this tier at
   * all; it needs no special-casing here. (The SAME tier also refuses
   * an object-with-toString()/valueOf() argument at the FRONTEND,
   * SC2020, "has no scriptc lowering yet" — measured directly,
   * CP2 findings §3 — so MEAS-11's toString-vs-valueOf row is likewise
   * unreachable, not merely untested.) The
   * doc-comment claim that dynToStr is "String(u)" (the NON-throwing
   * wrapper) rather than the throwing ToString abstract operation is a
   * FINDING, not yet cross-checked in a compiled module (CP2's own named
   * deliverable — do not assume equal on doc-comment resemblance). */
  dynToStr: () => number;
}

export class UriBuilder {
  private readonly fns = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: UriDeps,
  ) {}

  private strRef(): ValType {
    return this.deps.strRef();
  }
  private strType(): number {
    return this.deps.strType();
  }

  private cached(name: string, params: ValType[], results: ValType[], build: (idx: number) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.uri.${name}`);
    this.fns.set(name, idx);
    build(idx);
    return idx;
  }

  /** %w.uri.baseUnreserved(ch: i32) -> i32 bool — ALPHA / DIGIT /
   * `-_.!~*'()`, the 71-character set BOTH encoders leave alone (CP1
   * §3.1's measured `encodeURIComponent` set exactly; matches scr_
   * string.c's own stated component alphabet, confirmed not merely
   * assumed — CP1 §3.1). */
  private baseUnreservedHelper(): number {
    return this.cached("baseUnreserved", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      c.localGet(CH);
      c.i32Const(0x41); // 'A'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x5a); // 'Z'
      c.i32LeS();
      c.i32And();
      c.localGet(CH);
      c.i32Const(0x61); // 'a'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x7a); // 'z'
      c.i32LeS();
      c.i32And();
      c.i32Or();
      c.localGet(CH);
      c.i32Const(0x30); // '0'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x39); // '9'
      c.i32LeS();
      c.i32And();
      c.i32Or();
      // - _ . ! ~ * ' ( )
      for (const ch of [0x2d, 0x5f, 0x2e, 0x21, 0x7e, 0x2a, 0x27, 0x28, 0x29]) {
        c.localGet(CH);
        c.i32Const(ch);
        c.i32Eq();
        c.i32Or();
      }
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.extraReserved(ch: i32) -> i32 bool — the 11 characters
   * `encodeURI` ALSO leaves alone that `encodeURIComponent` escapes:
   * `#$&+,/:;=?@` (CP1 §3.1's measured delta, character-for-character —
   * NOT the spec's own reserved-set grouping, just the exact 11-code-
   * point set the 128-point sweep found). */
  private extraReservedHelper(): number {
    return this.cached("extraReserved", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const chars = [0x23, 0x24, 0x26, 0x2b, 0x2c, 0x2f, 0x3a, 0x3b, 0x3d, 0x3f, 0x40];
      c.localGet(CH);
      c.i32Const(chars[0]!);
      c.i32Eq();
      for (const ch of chars.slice(1)) {
        c.localGet(CH);
        c.i32Const(ch);
        c.i32Eq();
        c.i32Or();
      }
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.hexDigit(nibble: i32) -> i32 — the UPPERCASE hex digit
   * character for a 0..15 nibble (CP1 §3.1: every encode row measured
   * renders uppercase, never lowercase — the M-8 mutation's own axis). */
  private hexDigitHelper(): number {
    return this.cached("hexDigit", [I32], [I32], (idx) => {
      const c = new Code();
      const N = 0;
      c.localGet(N);
      c.i32Const(10);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(N);
      c.i32Const(0x30); // '0'
      c.i32Add();
      c.else_();
      c.localGet(N);
      c.i32Const(10);
      c.i32Sub();
      c.i32Const(0x41); // 'A'
      c.i32Add();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.percentEncode(s: str, keepReserved: i32) -> str — the
   * shared ENCODE walk both `encodeURI` (keepReserved=1) and
   * `encodeURIComponent` (keepReserved=0) call, a RUNTIME arg threaded
   * through ONE definition rather than two builders under different
   * names (v6 §11.2 CACHED). Per UTF-16 code unit: unreserved (base, or
   * base+extra when keepReserved) copies through; otherwise UTF-8-
   * encode the code point (1/2/3/4 bytes — a surrogate PAIR combines
   * into one astral code point exactly like typedarrays.ts's fromStr
   * utf8 arm; a LONE surrogate is the one place this walk's disposition
   * differs from that arm — THROW, never substitute, CP1 §3.2/§5's own
   * measured headline rule) and percent-escape each byte as uppercase
   * "%XX" directly into the output STRING (no intermediate `bytes`
   * value is ever materialized — CP1 §5's own stated design). Worst
   * case 9 output units per input unit (one BMP code point outside the
   * unreserved sets, 3 UTF-8 bytes, "%XX%XX%XX"), shrunk via a copy at
   * the end, the typedarrays.ts SCRATCH-then-shrink shape. */
  percentEncodeHelper(): number {
    return this.cached("percentEncode", [this.strRef(), I32], [this.strRef()], (idx) => {
      const c = new Code();
      const S = 0,
        KEEP = 1,
        N = 2,
        SCRATCH = 3,
        I = 4,
        O = 5,
        U = 6,
        NEXT = 7,
        PAIRED = 8,
        CP = 9,
        BYTE = 10,
        TMP = 11;
      const emitPercentByte = (pushByte: () => void): void => {
        // SCRATCH[O] = '%'; SCRATCH[O+1] = hex(byte>>4); SCRATCH[O+2] = hex(byte&0xF); O += 3.
        c.localGet(SCRATCH);
        c.localGet(O);
        c.i32Const(0x25); // '%'
        c.arraySet(this.strType());
        c.localGet(SCRATCH);
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        pushByte();
        c.localSet(BYTE);
        c.localGet(BYTE);
        c.i32Const(4);
        c.i32ShrU();
        c.call(this.hexDigitHelper());
        c.arraySet(this.strType());
        c.localGet(SCRATCH);
        c.localGet(O);
        c.i32Const(2);
        c.i32Add();
        c.localGet(BYTE);
        c.i32Const(0x0f);
        c.i32And();
        c.call(this.hexDigitHelper());
        c.arraySet(this.strType());
        c.localGet(O);
        c.i32Const(3);
        c.i32Add();
        c.localSet(O);
      };
      const throwMalformed = (): void => {
        this.deps.throwError(c, "%Error", "URIError", (x) => this.deps.lit(x, "URI malformed"));
        c.refNull(this.strType());
        c.return_();
      };

      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      c.localGet(N);
      c.i32Const(9);
      c.i32Mul();
      c.arrayNewDefault(this.strType());
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(I);
      c.i32Const(0);
      c.localSet(O);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.localSet(U);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);

      // Unreserved (base, or base+extra under keepReserved): copy through.
      c.localGet(U);
      c.call(this.baseUnreservedHelper());
      c.localGet(KEEP);
      c.ifResult(I32);
      c.localGet(U);
      c.call(this.extraReservedHelper());
      c.else_();
      c.i32Const(0);
      c.end();
      c.i32Or();
      c.ifVoid();
      {
        c.localGet(SCRATCH);
        c.localGet(O);
        c.localGet(U);
        c.arraySet(this.strType());
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localSet(O);
      }
      c.else_();
      {
        c.localGet(U);
        c.i32Const(0x80);
        c.i32LtU();
        c.ifVoid();
        {
          emitPercentByte(() => c.localGet(U));
        }
        c.else_();
        {
          c.localGet(U);
          c.i32Const(0x800);
          c.i32LtU();
          c.ifVoid();
          {
            emitPercentByte(() => {
              c.i32Const(0xc0);
              c.localGet(U);
              c.i32Const(6);
              c.i32ShrU();
              c.i32Or();
            });
            emitPercentByte(() => {
              c.i32Const(0x80);
              c.localGet(U);
              c.i32Const(0x3f);
              c.i32And();
              c.i32Or();
            });
          }
          c.else_();
          {
            c.localGet(U);
            c.i32Const(0xf800);
            c.i32And();
            c.i32Const(0xd800);
            c.i32Eq();
            c.ifVoid();
            {
              // A surrogate (high or low). Paired only if THIS is a high
              // half (< 0xDC00) and a low half immediately follows.
              c.i32Const(0);
              c.localSet(PAIRED);
              c.localGet(U);
              c.i32Const(0xdc00);
              c.i32LtU();
              c.ifVoid();
              c.localGet(I);
              c.localGet(N);
              c.i32LtU();
              c.ifVoid();
              c.localGet(S);
              c.localGet(I);
              c.arrayGetU(this.strType());
              c.localSet(NEXT);
              c.localGet(NEXT);
              c.i32Const(0xfc00);
              c.i32And();
              c.i32Const(0xdc00);
              c.i32Eq();
              c.ifVoid();
              c.i32Const(1);
              c.localSet(PAIRED);
              c.end();
              c.end();
              c.end();
              c.localGet(PAIRED);
              c.ifVoid();
              {
                c.localGet(U);
                c.i32Const(0xd800);
                c.i32Sub();
                c.i32Const(10);
                c.i32Shl();
                c.localGet(NEXT);
                c.i32Const(0xdc00);
                c.i32Sub();
                c.i32Add();
                c.i32Const(0x10000);
                c.i32Add();
                c.localSet(CP);
                c.localGet(I);
                c.i32Const(1);
                c.i32Add();
                c.localSet(I); // consume the low half too
                emitPercentByte(() => {
                  c.i32Const(0xf0);
                  c.localGet(CP);
                  c.i32Const(18);
                  c.i32ShrU();
                  c.i32Or();
                });
                emitPercentByte(() => {
                  c.i32Const(0x80);
                  c.localGet(CP);
                  c.i32Const(12);
                  c.i32ShrU();
                  c.i32Const(0x3f);
                  c.i32And();
                  c.i32Or();
                });
                emitPercentByte(() => {
                  c.i32Const(0x80);
                  c.localGet(CP);
                  c.i32Const(6);
                  c.i32ShrU();
                  c.i32Const(0x3f);
                  c.i32And();
                  c.i32Or();
                });
                emitPercentByte(() => {
                  c.i32Const(0x80);
                  c.localGet(CP);
                  c.i32Const(0x3f);
                  c.i32And();
                  c.i32Or();
                });
              }
              c.else_();
              {
                // A lone surrogate: THROW, never substitute (CP1 §3.2 —
                // the headline rule this whole pass exists to build).
                throwMalformed();
              }
              c.end();
            }
            c.else_();
            {
              // BMP, non-surrogate, >= 0x800: 3 bytes.
              emitPercentByte(() => {
                c.i32Const(0xe0);
                c.localGet(U);
                c.i32Const(12);
                c.i32ShrU();
                c.i32Or();
              });
              emitPercentByte(() => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(6);
                c.i32ShrU();
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
              emitPercentByte(() => {
                c.i32Const(0x80);
                c.localGet(U);
                c.i32Const(0x3f);
                c.i32And();
                c.i32Or();
              });
            }
            c.end();
          }
          c.end();
        }
        c.end();
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      // Shrink SCRATCH[0, O) into a fresh, exactly-sized result.
      c.localGet(O);
      c.arrayNewDefault(this.strType());
      c.localSet(TMP);
      c.localGet(TMP);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(this.strType(), this.strType());
      c.localGet(TMP);
      this.mb.setBody(
        idx,
        [I32, this.strRef(), I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.uri.encodeUriComponent(s) -> str — percentEncode with
   * keepReserved=0. */
  encodeUriComponentHelper(): number {
    return this.cached("encodeUriComponent", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.call(this.percentEncodeHelper());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.encodeUri(s) -> str — percentEncode with keepReserved=1. */
  encodeUriHelper(): number {
    return this.cached("encodeUri", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      c.localGet(0);
      c.i32Const(1);
      c.call(this.percentEncodeHelper());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.decodeUriComponent(s: str) -> str — the STRICT percent-
   * escape + UTF-8 decode (CP1 §6). Structurally the reverse of
   * percentEncode above and shaped like typedarrays.ts's toStrHelper
   * utf8 arm (the SAME lead-byte class table, the SAME E0/ED/F0/F4
   * bound-tightening — CP1 addendum §B4/E10: the byte-shape validity
   * rules are identical between the lenient and strict decoders, only
   * the ON-VIOLATION disposition differs), with two differences: (1)
   * every "byte" here is read from a "%XX" escape over a STRING, never
   * a raw `bytes` array — any code unit NOT introduced by '%' copies
   * through verbatim as its own code unit, untouched (CP1 §3.3's own
   * "raw non-ASCII beside escape" row: a literal é next to %41 is NOT
   * itself UTF-8-decoded); (2) ANY violation — bad hex, a non-'%'
   * continuation, a truncated escape (M-9, CP1 addendum §A7), an
   * overlong form, an encoded surrogate, or an out-of-range code point —
   * THROWS immediately (deps.throwError, "URI malformed" — CP1 §3.3:
   * every malformed row, both directions, carries this exact text) with
   * no resync and no U+FFFD, rather than the lenient decoder's
   * substitute-and-continue. A completed code point above 0xFFFF emits
   * as a SURROGATE PAIR (the C reference's own decoder never does this —
   * it writes validated UTF-8 straight through and never forms a code
   * point at all, CP1 addendum §B4/E11 — so it is a grammar/validity
   * reference only, never an output-shape one). Output is at most as
   * long as the input (every produced unit is spent on at least one
   * input code unit), so SCRATCH is sized to N, no worst-case blowup. */
  decodeUriComponentHelper(): number {
    return this.cached("decodeUriComponent", [this.strRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const S = 0,
        N = 1,
        SCRATCH = 2,
        I = 3,
        O = 4,
        CH = 5,
        LEAD = 6,
        H1 = 7,
        H2 = 8,
        NEEDED = 9,
        CP = 10,
        LOWER = 11,
        UPPER = 12,
        K = 13,
        BYTE = 14,
        TMP = 15;

      const throwMalformed = (): void => {
        this.deps.throwError(c, "%Error", "URIError", (x) => this.deps.lit(x, "URI malformed"));
        c.refNull(this.strType());
        c.return_();
      };
      // Reads one "%XX" escape at S[I..I+3), leaving the byte in BYTE and
      // advancing I by 3. Throws (not enough characters left, the
      // character at I is not '%', or either hex digit is invalid) —
      // used for BOTH the lead byte and every continuation byte, since
      // both are "the next thing in the input must be a %XX escape".
      const readByte = (): void => {
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.localGet(N);
        c.i32GeU();
        c.ifVoid();
        throwMalformed();
        c.end();
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.strType());
        c.i32Const(0x25); // '%'
        c.i32Ne();
        c.ifVoid();
        throwMalformed();
        c.end();
        c.localGet(S);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.arrayGetU(this.strType());
        c.call(this.deps.hexVal());
        c.localSet(H1);
        c.localGet(S);
        c.localGet(I);
        c.i32Const(2);
        c.i32Add();
        c.arrayGetU(this.strType());
        c.call(this.deps.hexVal());
        c.localSet(H2);
        c.localGet(H1);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        throwMalformed();
        c.end();
        c.localGet(H2);
        c.i32Const(0);
        c.i32LtS();
        c.ifVoid();
        throwMalformed();
        c.end();
        c.localGet(H1);
        c.i32Const(4);
        c.i32Shl();
        c.localGet(H2);
        c.i32Or();
        c.localSet(BYTE);
        c.localGet(I);
        c.i32Const(3);
        c.i32Add();
        c.localSet(I);
      };

      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      c.localGet(N);
      c.arrayNewDefault(this.strType());
      c.localSet(SCRATCH);
      c.i32Const(0);
      c.localSet(I);
      c.i32Const(0);
      c.localSet(O);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.localSet(CH);
      c.localGet(CH);
      c.i32Const(0x25); // '%'
      c.i32Ne();
      c.ifVoid();
      {
        c.localGet(SCRATCH);
        c.localGet(O);
        c.localGet(CH);
        c.arraySet(this.strType());
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localSet(O);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      }
      c.else_();
      {
        readByte();
        c.localGet(BYTE);
        c.localSet(LEAD);
        c.i32Const(0x80);
        c.localSet(LOWER);
        c.i32Const(0xbf);
        c.localSet(UPPER);

        c.localGet(LEAD);
        c.i32Const(0x80);
        c.i32LtU();
        c.ifVoid();
        {
          c.localGet(LEAD);
          c.localSet(CP);
          c.i32Const(0);
          c.localSet(NEEDED);
        }
        c.else_();
        {
          c.localGet(LEAD);
          c.i32Const(0xe0);
          c.i32And();
          c.i32Const(0xc0);
          c.i32Eq();
          c.ifVoid();
          {
            c.localGet(LEAD);
            c.i32Const(0xc2);
            c.i32LtU();
            c.ifVoid();
            throwMalformed(); // overlong 2-byte lead (C0/C1)
            c.end();
            c.localGet(LEAD);
            c.i32Const(0x1f);
            c.i32And();
            c.localSet(CP);
            c.i32Const(1);
            c.localSet(NEEDED);
          }
          c.else_();
          {
            c.localGet(LEAD);
            c.i32Const(0xf0);
            c.i32And();
            c.i32Const(0xe0);
            c.i32Eq();
            c.ifVoid();
            {
              c.localGet(LEAD);
              c.i32Const(0xe0);
              c.i32Eq();
              c.ifVoid();
              c.i32Const(0xa0);
              c.localSet(LOWER);
              c.end();
              c.localGet(LEAD);
              c.i32Const(0xed);
              c.i32Eq();
              c.ifVoid();
              c.i32Const(0x9f);
              c.localSet(UPPER);
              c.end();
              c.localGet(LEAD);
              c.i32Const(0x0f);
              c.i32And();
              c.localSet(CP);
              c.i32Const(2);
              c.localSet(NEEDED);
            }
            c.else_();
            {
              c.localGet(LEAD);
              c.i32Const(0xf8);
              c.i32And();
              c.i32Const(0xf0);
              c.i32Eq();
              c.localGet(LEAD);
              c.i32Const(0xf4);
              c.i32LeU();
              c.i32And();
              c.ifVoid();
              {
                c.localGet(LEAD);
                c.i32Const(0xf0);
                c.i32Eq();
                c.ifVoid();
                c.i32Const(0x90);
                c.localSet(LOWER);
                c.end();
                c.localGet(LEAD);
                c.i32Const(0xf4);
                c.i32Eq();
                c.ifVoid();
                c.i32Const(0x8f);
                c.localSet(UPPER);
                c.end();
                c.localGet(LEAD);
                c.i32Const(0x07);
                c.i32And();
                c.localSet(CP);
                c.i32Const(3);
                c.localSet(NEEDED);
              }
              c.else_();
              throwMalformed(); // a bare continuation byte, or F5-FF
              c.end();
            }
            c.end();
          }
          c.end();
        }
        c.end();

        c.i32Const(0);
        c.localSet(K);
        c.block();
        c.loop();
        c.localGet(K);
        c.localGet(NEEDED);
        c.i32GeS();
        c.brIf(1);
        readByte();
        c.localGet(BYTE);
        c.localGet(LOWER);
        c.i32LtU();
        c.localGet(BYTE);
        c.localGet(UPPER);
        c.i32GtU();
        c.i32Or();
        c.ifVoid();
        throwMalformed();
        c.end();
        c.localGet(CP);
        c.i32Const(6);
        c.i32Shl();
        c.localGet(BYTE);
        c.i32Const(0x3f);
        c.i32And();
        c.i32Or();
        c.localSet(CP);
        // Only the FIRST continuation byte uses the tightened bounds.
        c.i32Const(0x80);
        c.localSet(LOWER);
        c.i32Const(0xbf);
        c.localSet(UPPER);
        c.localGet(K);
        c.i32Const(1);
        c.i32Add();
        c.localSet(K);
        c.br(0);
        c.end();
        c.end();

        c.localGet(CP);
        c.i32Const(0xffff);
        c.i32LeU();
        c.ifVoid();
        {
          c.localGet(SCRATCH);
          c.localGet(O);
          c.localGet(CP);
          c.arraySet(this.strType());
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.localSet(O);
        }
        c.else_();
        {
          c.localGet(CP);
          c.i32Const(0x10000);
          c.i32Sub();
          c.localSet(CP);
          c.localGet(SCRATCH);
          c.localGet(O);
          c.i32Const(0xd800);
          c.localGet(CP);
          c.i32Const(10);
          c.i32ShrU();
          c.i32Add();
          c.arraySet(this.strType());
          c.localGet(SCRATCH);
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.i32Const(0xdc00);
          c.localGet(CP);
          c.i32Const(0x3ff);
          c.i32And();
          c.i32Add();
          c.arraySet(this.strType());
          c.localGet(O);
          c.i32Const(2);
          c.i32Add();
          c.localSet(O);
        }
        c.end();
      }
      c.end();
      c.br(0);
      c.end();
      c.end();
      // Shrink SCRATCH[0, O) into a fresh, exactly-sized result.
      c.localGet(O);
      c.arrayNewDefault(this.strType());
      c.localSet(TMP);
      c.localGet(TMP);
      c.i32Const(0);
      c.localGet(SCRATCH);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(this.strType(), this.strType());
      c.localGet(TMP);
      this.mb.setBody(
        idx,
        [I32, this.strRef(), I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.uri.b64Val(ch: i32) -> i32 — the standard base64 alphabet's
   * value (0-63), or -1: A-Z=0-25, a-z=26-51, 0-9=52-61, +=62, /=63. A
   * SEPARATE table from url.ts's hexVal (a different alphabet), so a
   * separate name (CP1 §8). */
  private b64ValHelper(): number {
    return this.cached("b64Val", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      c.localGet(CH);
      c.i32Const(0x41); // 'A'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x5a); // 'Z'
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(0x41);
      c.i32Sub();
      c.else_();
      c.localGet(CH);
      c.i32Const(0x61); // 'a'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x7a); // 'z'
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(0x61);
      c.i32Sub();
      c.i32Const(26);
      c.i32Add();
      c.else_();
      c.localGet(CH);
      c.i32Const(0x30); // '0'
      c.i32GeS();
      c.localGet(CH);
      c.i32Const(0x39); // '9'
      c.i32LeS();
      c.i32And();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(0x30);
      c.i32Sub();
      c.i32Const(52);
      c.i32Add();
      c.else_();
      c.localGet(CH);
      c.i32Const(0x2b); // '+'
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(62);
      c.else_();
      c.localGet(CH);
      c.i32Const(0x2f); // '/'
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(63);
      c.else_();
      c.i32Const(-1);
      c.end();
      c.end();
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.b64EncodeChar(v: i32 0..63) -> i32 — the inverse table. */
  private b64EncodeCharHelper(): number {
    return this.cached("b64EncodeChar", [I32], [I32], (idx) => {
      const c = new Code();
      const V = 0;
      c.localGet(V);
      c.i32Const(26);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(V);
      c.i32Const(0x41); // 'A'
      c.i32Add();
      c.else_();
      c.localGet(V);
      c.i32Const(52);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(V);
      c.i32Const(26);
      c.i32Sub();
      c.i32Const(0x61); // 'a'
      c.i32Add();
      c.else_();
      c.localGet(V);
      c.i32Const(62);
      c.i32LtS();
      c.ifResult(I32);
      c.localGet(V);
      c.i32Const(52);
      c.i32Sub();
      c.i32Const(0x30); // '0'
      c.i32Add();
      c.else_();
      c.localGet(V);
      c.i32Const(62);
      c.i32Eq();
      c.ifResult(I32);
      c.i32Const(0x2b); // '+'
      c.else_();
      c.i32Const(0x2f); // '/'  (the only remaining case, v==63)
      c.end();
      c.end();
      c.end();
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.isAtobWs(ch: i32) -> i32 bool — EXACTLY the five ASCII
   * whitespace characters forgiving-base64 strips (TAB/LF/FF/CR/SPACE).
   * NOT `%w.str.isWs` (CP1 addendum §A1/E8, independently verified by
   * reading strings.ts's own isWs builder): that helper is the full
   * ECMA-262 WhiteSpace ∪ LineTerminator set and additionally accepts
   * U+000B and NBSP, both of which Node's atob treats as INVALID
   * CHARACTERS, not strippable whitespace — reusing it would make atob
   * silently ACCEPT inputs Node rejects and return a WRONG VALUE, with
   * no corpus program to catch it. */
  private isAtobWsHelper(): number {
    return this.cached("isAtobWs", [I32], [I32], (idx) => {
      const c = new Code();
      const CH = 0;
      const chars = [0x09, 0x0a, 0x0c, 0x0d, 0x20];
      c.localGet(CH);
      c.i32Const(chars[0]!);
      c.i32Eq();
      for (const ch of chars.slice(1)) {
        c.localGet(CH);
        c.i32Const(ch);
        c.i32Eq();
        c.i32Or();
      }
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.uri.atob(d: dyn) -> str — D5. Node's error-selection rule
   * (lead-atob-rule-p5-v3.txt, sha256 056a97b7c88797b3931b4e9877e11cc577
   * ed9a816c7c4c04a36855fcdffc7f68 — cite v3, not v1/v2: v2's WORDING
   * dropped a load-bearing clause, caught by measurement, not argued;
   * the RULE ITSELF is what v1 stated and what this builds), a SURVIVING
   * MODEL over ~3.6M refutation attempts across three independent
   * implementations, not a proof — the D5 pin (wasm-uri.test.ts) still
   * computes every expected value from Node in-process and is the
   * actual authority; if this code and that pin ever disagree, the
   * finding is against v3, not the pin.
   *   Let S = the ToString'd input with the five whitespace characters
   *     removed from anywhere in it.
   *   Let P = the size of the maximal run of '=' at the END of S.
   *   Let D = S with that trailing run removed ("the data").
   *   1. P > 2                                    -> InvalidCharacterError
   *      "Invalid character"
   *   2. any character of D outside [A-Za-z0-9+/]  -> same (an INTERIOR
   *      '=' counts: it is not part of the trailing run, so it is IN D)
   *   3. |D| mod 4 == 1                            -> InvalidCharacterError
   *      "The string to be decoded is not correctly encoded."
   *   4. P > 0 AND (|D| + P) mod 4 != 0            -> "Invalid character"
   *   5. otherwise decode D, discarding leftover bits.
   * Step 3 BEFORE step 4 is rev's six survivor rows (E6/D-3 — carried as
   * INPUTS in the pin, computed from Node, never transcribed). Step 1
   * BEFORE step 3 is why "Y===" answers CHARACTER despite |D|=1.
   * `.code` is real in Node (5, INVALID_CHARACTER_ERR) but not wired
   * here (codeLit=null) — nothing D4's eight exposes it through (E7). */
  atobHelper(): number {
    return this.cached("atob", [this.deps.dynRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const D = 0,
        S = 1,
        N = 2,
        STRIPPED = 3,
        SN = 4,
        I = 5,
        O = 6,
        CH = 7,
        P = 8,
        DN = 9,
        K = 10,
        V = 11,
        ACC = 12,
        HAVE = 13,
        OUT = 14,
        OI = 15,
        TMP = 16;

      const throwInvalidChar = (): void => {
        this.deps.throwError(c, "%DOMException", "InvalidCharacterError", (x) => this.deps.lit(x, "Invalid character"));
        c.refNull(this.strType());
        c.return_();
      };
      const throwNotEncoded = (): void => {
        this.deps.throwError(c, "%DOMException", "InvalidCharacterError", (x) =>
          this.deps.lit(x, "The string to be decoded is not correctly encoded."),
        );
        c.refNull(this.strType());
        c.return_();
      };

      // S = ToString(D).
      c.localGet(D);
      c.call(this.deps.dynToStr());
      c.localSet(S);
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);

      // STRIPPED = S with the five whitespace characters removed, in order.
      c.localGet(N);
      c.arrayNewDefault(this.strType());
      c.localSet(STRIPPED);
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.localSet(CH);
      c.localGet(CH);
      c.call(this.isAtobWsHelper());
      c.ifVoid();
      // dropped
      c.else_();
      {
        c.localGet(STRIPPED);
        c.localGet(O);
        c.localGet(CH);
        c.arraySet(this.strType());
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localSet(O);
      }
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(O);
      c.localSet(SN);

      // P = the trailing '=' run's size.
      c.i32Const(0);
      c.localSet(P);
      c.block();
      c.loop();
      c.localGet(P);
      c.localGet(SN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(STRIPPED);
      c.localGet(SN);
      c.i32Const(1);
      c.i32Sub();
      c.localGet(P);
      c.i32Sub();
      c.arrayGetU(this.strType());
      c.i32Const(0x3d); // '='
      c.i32Ne();
      c.brIf(1);
      c.localGet(P);
      c.i32Const(1);
      c.i32Add();
      c.localSet(P);
      c.br(0);
      c.end();
      c.end();

      c.localGet(SN);
      c.localGet(P);
      c.i32Sub();
      c.localSet(DN);

      // Step 1.
      c.localGet(P);
      c.i32Const(2);
      c.i32GtS();
      c.ifVoid();
      throwInvalidChar();
      c.end();

      // Step 2: every character of D (STRIPPED[0, DN)) must be alphabet.
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(DN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(STRIPPED);
      c.localGet(K);
      c.arrayGetU(this.strType());
      c.call(this.b64ValHelper());
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      throwInvalidChar();
      c.end();
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();

      // Step 3.
      c.localGet(DN);
      c.i32Const(4);
      c.i32RemS();
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      throwNotEncoded();
      c.end();

      // Step 4.
      c.localGet(P);
      c.i32Const(0);
      c.i32GtS();
      c.ifVoid();
      {
        c.localGet(DN);
        c.localGet(P);
        c.i32Add();
        c.i32Const(4);
        c.i32RemS();
        c.i32Const(0);
        c.i32Ne();
        c.ifVoid();
        throwInvalidChar();
        c.end();
      }
      c.end();

      // Step 5: decode D, discarding leftover bits. Every byte is
      // masked to 8 bits explicitly before storing — unlike typedarrays.
      // ts's own base64-decode-to-bytes<u8> precedent, this output is a
      // STRING (16-bit storage), which does not truncate on its own.
      c.localGet(DN);
      c.arrayNewDefault(this.strType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(OI);
      c.i32Const(0);
      c.localSet(ACC);
      c.i32Const(0);
      c.localSet(HAVE);
      c.i32Const(0);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(DN);
      c.i32GeS();
      c.brIf(1);
      c.localGet(STRIPPED);
      c.localGet(K);
      c.arrayGetU(this.strType());
      c.call(this.b64ValHelper());
      c.localSet(V);
      c.localGet(ACC);
      c.i32Const(6);
      c.i32Shl();
      c.localGet(V);
      c.i32Or();
      c.localSet(ACC);
      c.localGet(HAVE);
      c.i32Const(1);
      c.i32Add();
      c.localSet(HAVE);
      c.localGet(HAVE);
      c.i32Const(4);
      c.i32Eq();
      c.ifVoid();
      {
        for (const shift of [16, 8, 0]) {
          c.localGet(OUT);
          c.localGet(OI);
          c.localGet(ACC);
          c.i32Const(shift);
          c.i32ShrU();
          c.i32Const(0xff);
          c.i32And();
          c.arraySet(this.strType());
          c.localGet(OI);
          c.i32Const(1);
          c.i32Add();
          c.localSet(OI);
        }
        c.i32Const(0);
        c.localSet(ACC);
        c.i32Const(0);
        c.localSet(HAVE);
      }
      c.end();
      c.localGet(K);
      c.i32Const(1);
      c.i32Add();
      c.localSet(K);
      c.br(0);
      c.end();
      c.end();
      c.localGet(HAVE);
      c.i32Const(2);
      c.i32Eq();
      c.ifVoid();
      {
        c.localGet(OUT);
        c.localGet(OI);
        c.localGet(ACC);
        c.i32Const(4);
        c.i32ShrU();
        c.i32Const(0xff);
        c.i32And();
        c.arraySet(this.strType());
        c.localGet(OI);
        c.i32Const(1);
        c.i32Add();
        c.localSet(OI);
      }
      c.else_();
      {
        c.localGet(HAVE);
        c.i32Const(3);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(OUT);
          c.localGet(OI);
          c.localGet(ACC);
          c.i32Const(10);
          c.i32ShrU();
          c.i32Const(0xff);
          c.i32And();
          c.arraySet(this.strType());
          c.localGet(OUT);
          c.localGet(OI);
          c.i32Const(1);
          c.i32Add();
          c.localGet(ACC);
          c.i32Const(2);
          c.i32ShrU();
          c.i32Const(0xff);
          c.i32And();
          c.arraySet(this.strType());
          c.localGet(OI);
          c.i32Const(2);
          c.i32Add();
          c.localSet(OI);
        }
        c.end();
      }
      c.end();

      c.localGet(OI);
      c.arrayNewDefault(this.strType());
      c.localSet(TMP);
      c.localGet(TMP);
      c.i32Const(0);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(OI);
      c.arrayCopy(this.strType(), this.strType());
      c.localGet(TMP);
      this.mb.setBody(
        idx,
        [
          this.strRef(),
          I32,
          this.strRef(),
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          I32,
          this.strRef(),
          I32,
          this.strRef(),
        ],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.uri.btoa(d: dyn) -> str — D5. ToString(d) (MEAS-11, same
   * coercion as atob's), then the Latin-1 range check (any code unit
   * over 0xFF throws — CP1 §3.7), then standard base64 ENCODE: 3 bytes
   * -> 4 characters, with '=' padding for a 1- or 2-byte remainder.
   * Node's btoa caller has exactly ONE error text (CP1 addendum §A5/E9),
   * unlike atob's two. */
  btoaHelper(): number {
    return this.cached("btoa", [this.deps.dynRef()], [this.strRef()], (idx) => {
      const c = new Code();
      const D = 0,
        S = 1,
        N = 2,
        I = 3,
        CH = 4,
        OUT = 5,
        O = 6,
        B0 = 7,
        B1 = 8,
        B2 = 9,
        REM = 10,
        TMP = 11;

      const throwInvalidChar = (): void => {
        this.deps.throwError(c, "%DOMException", "InvalidCharacterError", (x) => this.deps.lit(x, "Invalid character"));
        c.refNull(this.strType());
        c.return_();
      };

      c.localGet(D);
      c.call(this.deps.dynToStr());
      c.localSet(S);
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);

      // Latin-1 range check: every code unit must be <= 0xFF.
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(N);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.i32Const(0xff);
      c.i32GtU();
      c.ifVoid();
      throwInvalidChar();
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      // Output: ceil(N/3)*4 units, worst case (N%3!=0 pads to a full group).
      c.localGet(N);
      c.i32Const(2);
      c.i32Add();
      c.i32Const(3);
      c.i32DivS();
      c.i32Const(4);
      c.i32Mul();
      c.arrayNewDefault(this.strType());
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(O);
      c.i32Const(0);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(3);
      c.i32Add();
      c.localGet(N);
      c.i32GtU();
      c.brIf(1); // fewer than 3 remain: fall to the leftover handling below
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType());
      c.localSet(B0);
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType());
      c.localSet(B1);
      c.localGet(S);
      c.localGet(I);
      c.i32Const(2);
      c.i32Add();
      c.arrayGetU(this.strType());
      c.localSet(B2);
      c.localGet(OUT);
      c.localGet(O);
      c.localGet(B0);
      c.i32Const(2);
      c.i32ShrU();
      c.call(this.b64EncodeCharHelper());
      c.arraySet(this.strType());
      c.localGet(OUT);
      c.localGet(O);
      c.i32Const(1);
      c.i32Add();
      c.localGet(B0);
      c.i32Const(0x3);
      c.i32And();
      c.i32Const(4);
      c.i32Shl();
      c.localGet(B1);
      c.i32Const(4);
      c.i32ShrU();
      c.i32Or();
      c.call(this.b64EncodeCharHelper());
      c.arraySet(this.strType());
      c.localGet(OUT);
      c.localGet(O);
      c.i32Const(2);
      c.i32Add();
      c.localGet(B1);
      c.i32Const(0xf);
      c.i32And();
      c.i32Const(2);
      c.i32Shl();
      c.localGet(B2);
      c.i32Const(6);
      c.i32ShrU();
      c.i32Or();
      c.call(this.b64EncodeCharHelper());
      c.arraySet(this.strType());
      c.localGet(OUT);
      c.localGet(O);
      c.i32Const(3);
      c.i32Add();
      c.localGet(B2);
      c.i32Const(0x3f);
      c.i32And();
      c.call(this.b64EncodeCharHelper());
      c.arraySet(this.strType());
      c.localGet(O);
      c.i32Const(4);
      c.i32Add();
      c.localSet(O);
      c.localGet(I);
      c.i32Const(3);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

      c.localGet(N);
      c.localGet(I);
      c.i32Sub();
      c.localSet(REM);
      c.localGet(REM);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      {
        c.localGet(S);
        c.localGet(I);
        c.arrayGetU(this.strType());
        c.localSet(B0);
        c.localGet(OUT);
        c.localGet(O);
        c.localGet(B0);
        c.i32Const(2);
        c.i32ShrU();
        c.call(this.b64EncodeCharHelper());
        c.arraySet(this.strType());
        c.localGet(OUT);
        c.localGet(O);
        c.i32Const(1);
        c.i32Add();
        c.localGet(B0);
        c.i32Const(0x3);
        c.i32And();
        c.i32Const(4);
        c.i32Shl();
        c.call(this.b64EncodeCharHelper());
        c.arraySet(this.strType());
        c.localGet(OUT);
        c.localGet(O);
        c.i32Const(2);
        c.i32Add();
        c.i32Const(0x3d); // '='
        c.arraySet(this.strType());
        c.localGet(OUT);
        c.localGet(O);
        c.i32Const(3);
        c.i32Add();
        c.i32Const(0x3d);
        c.arraySet(this.strType());
        c.localGet(O);
        c.i32Const(4);
        c.i32Add();
        c.localSet(O);
      }
      c.else_();
      {
        c.localGet(REM);
        c.i32Const(2);
        c.i32Eq();
        c.ifVoid();
        {
          c.localGet(S);
          c.localGet(I);
          c.arrayGetU(this.strType());
          c.localSet(B0);
          c.localGet(S);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.arrayGetU(this.strType());
          c.localSet(B1);
          c.localGet(OUT);
          c.localGet(O);
          c.localGet(B0);
          c.i32Const(2);
          c.i32ShrU();
          c.call(this.b64EncodeCharHelper());
          c.arraySet(this.strType());
          c.localGet(OUT);
          c.localGet(O);
          c.i32Const(1);
          c.i32Add();
          c.localGet(B0);
          c.i32Const(0x3);
          c.i32And();
          c.i32Const(4);
          c.i32Shl();
          c.localGet(B1);
          c.i32Const(4);
          c.i32ShrU();
          c.i32Or();
          c.call(this.b64EncodeCharHelper());
          c.arraySet(this.strType());
          c.localGet(OUT);
          c.localGet(O);
          c.i32Const(2);
          c.i32Add();
          c.localGet(B1);
          c.i32Const(0xf);
          c.i32And();
          c.i32Const(2);
          c.i32Shl();
          c.call(this.b64EncodeCharHelper());
          c.arraySet(this.strType());
          c.localGet(OUT);
          c.localGet(O);
          c.i32Const(3);
          c.i32Add();
          c.i32Const(0x3d); // '='
          c.arraySet(this.strType());
          c.localGet(O);
          c.i32Const(4);
          c.i32Add();
          c.localSet(O);
        }
        c.end();
      }
      c.end();

      c.localGet(O);
      c.arrayNewDefault(this.strType());
      c.localSet(TMP);
      c.localGet(TMP);
      c.i32Const(0);
      c.localGet(OUT);
      c.i32Const(0);
      c.localGet(O);
      c.arrayCopy(this.strType(), this.strType());
      c.localGet(TMP);
      this.mb.setBody(
        idx,
        [this.strRef(), I32, I32, I32, this.strRef(), I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }
}
