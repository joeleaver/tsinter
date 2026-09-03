/* INC-24 P1, CP4 back half: the regex VALUE (design §3.2) and its
 * data-embedding path (§3.3) — the %w.re.Regex struct and the literal-
 * interning constructor that materializes one, embedding its bytecode
 * (and source/flags/groupNames text) into the module.
 *
 * THE STRUCT (§3.2, verbatim field list, IMMUTABLE after construction —
 * every field below is `mutable: false`):
 *   source       (ref null $str)     the pattern text, for .source
 *   flags        (ref null $str)     ALREADY IN CANONICAL ORDER (§5.5) —
 *                                    this builder does not sort; the
 *                                    caller (a future pass's parser-
 *                                    driven construction) owns that
 *   bytecode     (ref null $u8arr)   materialised from segment 0
 *   captureCount i32                 from the bytecode header
 *   groupNames   (ref null $strarr)  null when the pattern has no named
 *                                    groups
 *
 * EMBEDDING MECHANISM (§3.3): the repo's one supported mechanism,
 * unchanged — internData(bytes) -> a passive-segment byte offset (exact-
 * match dedup, so identical bytecode/text across call sites costs once)
 * plus array.new_data. Unlike emitter.ts's own pushStrLitInto (which
 * re-materializes an ordinary string literal INLINE at every use site,
 * cheap and uncached, since array.new_data itself is a normal
 * instruction), THIS builder needs literal INTERNING: §3.2's own words,
 * "one immortal per (pattern, flags) pair per module, matching the C
 * lane's sc_re_N statics (emit-exprs.ts:698-712), so `re === re` holds
 * and repeated evaluation is free." That needs a PER-LITERAL guard: a
 * null-initialised global holding the WHOLE constructed struct, plus a
 * guard function that constructs-and-caches on first call — exactly
 * casing.ts's %w.str.caseInit shape (array.new_data is not a GC
 * constexpr, the increment-13 lesson, restated at casing.ts:22-26),
 * generalized from "one shared guard for shared tables" to "one guard
 * PER LITERAL" since (unlike casing's fixed tables) every regex literal
 * is its own distinct value. The struct's OWN fields (source/flags/
 * bytecode/groupNames) are constructed INLINE inside that one guard,
 * mirroring pushStrLitInto's own array.new_data call shape directly —
 * they do not need their own separate guards, because the OUTER
 * guard already ensures the whole body (including those inline
 * array.new_data calls) runs at most once.
 *
 * A module with no regex literal never pays for any of this: this
 * class is only ever instantiated through a `get regex()` accessor
 * (the `get casing()` pattern, emitter.ts:14588) and every internData
 * call here happens lazily inside regexLiteral(), never in the
 * constructor — so simply never calling regexLiteral() embeds zero
 * regex bytes, matching casing.ts's own "instantiated lazily, on
 * first actual reference" convention exactly. */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";

export class RegexBuilder {
  private readonly literals = new Map<string, number>();
  private escapeFn: number | null = null;
  private inspectFn: number | null = null;

  readonly regexType: number;
  // Public: the ONE nominal bytecode array type this module's regex
  // values are built with. RegexInterpreterBuilder needs the SAME type
  // index (not a structurally-identical second one) to accept a
  // bytecode ref pulled via struct.get on a %w.re.Regex value — its own
  // constructor's injectedBcType param exists for exactly this (mirrors
  // the injectedCasing precedent already there).
  readonly bcType: number;
  // Public, same reasoning as bcType above: GetSubstitution (P3) needs
  // the exact nominal type of the groupNames field to declare its own
  // function parameter — a struct.get pulls the FIELD fine regardless,
  // but a function signature naming that field's element type needs the
  // concrete index, not a structurally-identical second one.
  readonly strArrType: number;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number,
  ) {
    this.bcType = mb.arrayType("i8", false);
    this.strArrType = mb.arrayType(this.strRef(), false);
    // Field order below is the ORDER struct.new expects operands on the
    // stack in regexLiteral() — source, flags, bytecode, captureCount,
    // groupNames. Changing one without the other is a live miscompile,
    // not a validator error (struct.new only checks TYPES, not which
    // logical field a same-typed operand landed in).
    this.regexType = mb.structType([
      { storage: this.strRef(), mutable: false }, // source
      { storage: this.strRef(), mutable: false }, // flags
      { storage: this.bcRef(), mutable: false }, // bytecode
      { storage: I32, mutable: false }, // captureCount
      { storage: this.strArrRef(), mutable: false }, // groupNames
    ]);
  }

  private strRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  private bcRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bcType };
  }

  private strArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strArrType };
  }

  private regexRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.regexType };
  }

  /** pushStrLitInto's own array.new_data shape (emitter.ts:14846-14860),
   * duplicated rather than imported: emitter.ts imports FROM this file
   * (once a `get regex()` accessor exists there), and the reverse would
   * be circular. UTF-16LE code units, raw (charCodeAt, not TextEncoder
   * — S002, lone surrogates preserved). */
  private pushStrLit(c: Code, value: string): void {
    const units = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      const u = value.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    const offset = this.mb.internData(units);
    c.i32Const(offset);
    c.i32Const(value.length);
    c.arrayNewData(this.strType, 0);
  }

  /** Literal interning (§3.2): ONE immortal %w.re.Regex per (source,
   * flags) pair per module. `bytecode`/`captureCount`/`groupNames` are
   * supplied by the caller (this port's own already-verified parser+
   * assembler pipeline — CP2/CP3 — is the only intended source; this
   * builder does not re-derive them, matching regex-interpreter.ts's
   * own division of labour: compile-time decisions stay compile-time).
   * Returns a zero-arg function index; CALLING it returns the cached
   * struct, constructing+embedding everything on the FIRST call only
   * (array.new_data is not a GC constexpr, so this cannot be a global
   * initializer expression — the guard is required, not a convenience).
   *
   * KEYED BY JSON.stringify([source, flags]), not a manually-delimited
   * template string: a hand-picked delimiter character risks exactly
   * the kind of key-construction mistake this pass already hit once
   * this session (a stray byte silently breaking a template-literal
   * key two call sites apart, undetected until a lookup came back
   * empty — see findings' own "NON-STICKY SEARCH-LOOP PRELUDE" entry).
   * JSON.stringify escapes its own delimiters, so no pattern text can
   * ever forge a collision or a corrupt key. */
  regexLiteral(source: string, flags: string, bytecode: Uint8Array, captureCount: number, groupNames: readonly string[] | null): number {
    const key = JSON.stringify([source, flags]);
    const hit = this.literals.get(key);
    if (hit !== undefined) return hit;

    const nullInit = (typeIndex: number) => (w: ByteWriter) => {
      w.u8(0xd0); // ref.null
      w.sleb(typeIndex);
    };
    const g = this.mb.addGlobal(this.regexRef(), true, nullInit(this.regexType));

    const idx = this.mb.declareFunc(this.mb.funcType([], [this.regexRef()]), "%w.re.lit");
    const c = new Code();
    c.globalGet(g);
    c.refIsNull();
    c.ifVoid();
    this.pushStrLit(c, source);
    this.pushStrLit(c, flags);
    const bcOffset = this.mb.internData(bytecode);
    c.i32Const(bcOffset);
    c.i32Const(bytecode.length);
    c.arrayNewData(this.bcType, 0);
    c.i32Const(captureCount);
    if (groupNames === null) {
      c.refNull(this.strArrType);
    } else {
      for (const name of groupNames) this.pushStrLit(c, name);
      c.arrayNewFixed(this.strArrType, groupNames.length);
    }
    c.structNew(this.regexType);
    c.globalSet(g);
    c.end();
    c.globalGet(g);
    this.mb.setBody(idx, [], c.bytes());

    this.literals.set(key, idx);
    return idx;
  }

  /** Non-interned regex CONSTRUCTION (regex.new — design §7.5's own NAMED
   * NON-REQUIREMENT: do NOT intern. `new RegExp("a") === new RegExp("a")`
   * is `false` in Node, unlike a regex LITERAL's own one-immortal-per-
   * (source,flags) dedup). Emits the struct.new sequence directly onto
   * `c`'s own instruction stream — no guard, no global, no cache lookup:
   * every time the emitted code runs, it executes a fresh array.new_data
   * + struct.new, producing a genuinely new struct instance (WasmGC's
   * own semantics: array.new_data always allocates a new array, no
   * matter how many times internData has already deduped the SAME
   * underlying bytes into one passive segment — the dedup is about the
   * segment's bytes, never about the identity of values later
   * materialised from them). Does NOT call regexLiteral(): that method's
   * entire reason to exist is the cache this constructor must not have. */
  regexConstruct(c: Code, source: string, flags: string, bytecode: Uint8Array, captureCount: number, groupNames: readonly string[] | null): void {
    this.pushStrLit(c, source);
    this.pushStrLit(c, flags);
    const bcOffset = this.mb.internData(bytecode);
    c.i32Const(bcOffset);
    c.i32Const(bytecode.length);
    c.arrayNewData(this.bcType, 0);
    c.i32Const(captureCount);
    if (groupNames === null) {
      c.refNull(this.strArrType);
    } else {
      for (const name of groupNames) this.pushStrLit(c, name);
      c.arrayNewFixed(this.strArrType, groupNames.length);
    }
    c.structNew(this.regexType);
  }

  /** %w.re.escape(s) — the general RUNTIME `regexp.escape` libCall
   * (design §7.6: "not a second algorithm" — this is the SAME
   * EncodeForRegExpEscape classification regexp-escape.ts's own
   * escapeRegExpText runs at COMPILE TIME for a foldable argument,
   * reimplemented as wasm instructions here because 2367's own `dyn`
   * case (`RegExp.escape(dyn)` over a genuinely runtime string, not a
   * folded one) needs it to run over ANY string value.
   *
   * ONE PASS, UPPER-BOUND SCRATCH (casing.ts's own toLower/toUpper
   * shape, `L * 3`, adapted here to `L * 6` — the widest single-unit
   * expansion this algorithm has, `\uHHHH`, is 6 output units for 1
   * input unit): allocate a scratch array sized for the worst case,
   * write into it while walking `s` once, then arrayCopy only the
   * ACTUALLY-used prefix into an exact-size result. Avoids a genuine
   * two-pass (measure-then-fill) walk entirely.
   *
   * CODE-UNIT walk, not code-point (measured equivalent to the spec's
   * own per-code-point algorithm for this specific rule set — see
   * regexp-escape.ts's own doc comment: every character this algorithm
   * treats specially is BMP, so no member of SYNTAX_CHARS/the control-
   * escape five/the hex-escape set is ever a surrogate half, meaning a
   * surrogate half is ALWAYS classified "pass through unchanged" either
   * way, and the "first code point" leading-alnum rule can never fire
   * on a surrogate half either, since no astral character is ASCII
   * alphanumeric — verified directly against live Node, including an
   * astral character as the string's own first character). `arrayGetU`
   * over the faithful (array (mut i16)) storage IS the code-unit walk,
   * with no decode step, matching strings.ts's own established
   * convention throughout this file's sibling builders. */
  escapeHelper(): number {
    if (this.escapeFn !== null) return this.escapeFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.strRef()]), "%w.re.escape");
    this.escapeFn = idx;
    const c = new Code();
    const S = 0;
    const L = 1;
    const I = 2;
    const N = 3;
    const OUT = 4;
    const U = 5;
    const R = 6;
    const D = 7;

    const emitWriteChar = (pushCode: () => void): void => {
      c.localGet(OUT);
      c.localGet(N);
      pushCode();
      c.arraySet(this.strType);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.localSet(N);
    };
    const pushHexNibble = (shift: number): void => {
      c.localGet(U);
      if (shift !== 0) {
        c.i32Const(shift);
        c.i32ShrU();
      }
      c.i32Const(0xf);
      c.i32And();
      c.localSet(D);
      c.localGet(D);
      c.i32Const(10);
      c.i32LtU();
      c.ifResult(I32);
      c.localGet(D);
      c.i32Const(0x30); // '0'
      c.i32Add();
      c.else_();
      c.localGet(D);
      c.i32Const(0x57); // 10 + 0x57 == 'a'
      c.i32Add();
      c.end();
    };
    const pushU = (): void => c.localGet(U);
    const pushMembership = (codes: readonly number[]): void => {
      c.localGet(U);
      c.i32Const(codes[0]!);
      c.i32Eq();
      for (const k of codes.slice(1)) {
        c.localGet(U);
        c.i32Const(k);
        c.i32Eq();
        c.i32Or();
      }
    };

    // SYNTAX_CHARS: ^ $ \ . * + ? ( ) [ ] { } | /
    const SYNTAX_CHARS = [0x5e, 0x24, 0x5c, 0x2e, 0x2a, 0x2b, 0x3f, 0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d, 0x7c, 0x2f];
    // OTHER_PUNCTUATORS: , - = < > # & ! % : ; @ ~ ' ` "
    const OTHER_PUNCTUATORS = [0x2c, 0x2d, 0x3d, 0x3c, 0x3e, 0x23, 0x26, 0x21, 0x25, 0x3a, 0x3b, 0x40, 0x7e, 0x27, 0x60, 0x22];
    // WhiteSpace/LineTerminator singles NOT already a ControlEscape letter.
    const HEX_ESCAPED_SINGLES = [0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];

    c.localGet(S);
    c.arrayLen();
    c.localSet(L);
    // Overflow guard (casing.ts's own `L * 3` precedent, here `L * 6` —
    // the widest single-unit expansion, \uHHHH).
    c.localGet(L);
    c.f64ConvertI32S();
    c.f64Const(6);
    c.f64Mul();
    c.f64Const(2147483648);
    c.f64Ge();
    c.ifVoid();
    c.unreachable();
    c.end();
    c.localGet(L);
    c.i32Const(6);
    c.i32Mul();
    c.arrayNewDefault(this.strType);
    c.localSet(OUT);
    c.i32Const(0);
    c.localSet(N);
    c.i32Const(0);
    c.localSet(I);

    c.block(); // OUTER
    c.loop(); // LOOP
    c.localGet(I);
    c.localGet(L);
    c.i32GeS();
    c.brIf(1);
    c.localGet(S);
    c.localGet(I);
    c.arrayGetU(this.strType);
    c.localSet(U);

    c.block(); // UNIT — every arm taken leaves through this block's end via br(1) (one level past its own enclosing `if`)

    // 1. A LEADING (string index 0 only) ASCII alphanumeric hex-escapes,
    //    so a concatenation can never extend a preceding token.
    c.localGet(I);
    c.i32Const(0);
    c.i32Eq();
    c.localGet(U);
    c.i32Const(0x30);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x39);
    c.i32LeU();
    c.i32And();
    c.localGet(U);
    c.i32Const(0x41);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x5a);
    c.i32LeU();
    c.i32And();
    c.i32Or();
    c.localGet(U);
    c.i32Const(0x61);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x7a);
    c.i32LeU();
    c.i32And();
    c.i32Or();
    c.i32And();
    // NB: br(1), not br(0) — an `if` is ITSELF a branch target (label 0
    // is the if's own end, one past nothing since it's void), so exiting
    // the ENCLOSING "UNIT" block from directly inside one of these arms
    // needs the label ONE FURTHER OUT. (Found by running this exact
    // function: br(0) here silently fell through to arm 5's unconditional
    // pass-through after every escape, duplicating every character —
    // "a.b" came out "\x61a\..b" instead of "\x61\.b".)
    c.ifVoid();
    emitWriteChar(() => c.i32Const(0x5c));
    emitWriteChar(() => c.i32Const(0x78)); // 'x'
    emitWriteChar(() => pushHexNibble(4));
    emitWriteChar(() => pushHexNibble(0));
    c.br(1);
    c.end();

    // 2. SyntaxCharacters backslash-escape as themselves.
    pushMembership(SYNTAX_CHARS);
    c.ifVoid();
    emitWriteChar(() => c.i32Const(0x5c));
    emitWriteChar(pushU);
    c.br(1);
    c.end();

    // 3. The ControlEscape five: \t \n \v \f \r.
    for (const [ctrl, letter] of [
      [0x09, 0x74],
      [0x0a, 0x6e],
      [0x0b, 0x76],
      [0x0c, 0x66],
      [0x0d, 0x72],
    ]) {
      c.localGet(U);
      c.i32Const(ctrl!);
      c.i32Eq();
      c.ifVoid();
      emitWriteChar(() => c.i32Const(0x5c));
      emitWriteChar(() => c.i32Const(letter!));
      c.br(1);
      c.end();
    }

    // 4. "Other punctuators" plus WhiteSpace/LineTerminator (less the
    //    five above): hex-escape, \xHH below 0x100 else \uHHHH.
    pushMembership(OTHER_PUNCTUATORS);
    pushMembership(HEX_ESCAPED_SINGLES);
    c.i32Or();
    c.localGet(U);
    c.i32Const(0x2000);
    c.i32GeU();
    c.localGet(U);
    c.i32Const(0x200a);
    c.i32LeU();
    c.i32And();
    c.i32Or();
    c.ifVoid();
    c.localGet(U);
    c.i32Const(0x100);
    c.i32LtU();
    c.ifVoid();
    emitWriteChar(() => c.i32Const(0x5c));
    emitWriteChar(() => c.i32Const(0x78)); // 'x'
    emitWriteChar(() => pushHexNibble(4));
    emitWriteChar(() => pushHexNibble(0));
    c.else_();
    emitWriteChar(() => c.i32Const(0x5c));
    emitWriteChar(() => c.i32Const(0x75)); // 'u'
    emitWriteChar(() => pushHexNibble(12));
    emitWriteChar(() => pushHexNibble(8));
    emitWriteChar(() => pushHexNibble(4));
    emitWriteChar(() => pushHexNibble(0));
    c.end();
    c.br(1); // same fix as above — still directly inside the OUTER ifVoid here
    c.end();

    // 5. Default: pass through unchanged (no wrapping ifVoid — this is
    //    the fallthrough once every check above has declined to br(0)).
    emitWriteChar(pushU);

    c.end(); // UNIT

    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end(); // LOOP
    c.end(); // OUTER

    c.localGet(N);
    c.arrayNewDefault(this.strType);
    c.localSet(R);
    c.localGet(R);
    c.i32Const(0);
    c.localGet(OUT);
    c.i32Const(0);
    c.localGet(N);
    c.arrayCopy(this.strType, this.strType);
    c.localGet(R);
    this.mb.setBody(idx, [I32, I32, I32, this.strRef(), I32, this.strRef(), I32], c.bytes());
    return idx;
  }

  /** %w.re.inspect(regex) → str — `insp.regex` (design's own scr_inspect.c
   * reference, scr_insp_regex at runtime/src/scr_inspect.c:618-625):
   * `/source/flags`, unconditionally — RegExp.prototype.toString's own
   * shape, and (per that file's own comment) "our regexes never carry
   * extra own properties," so util.inspect's usual own-property sweep
   * never applies here; a regex value renders identically at any depth.
   * `source` is ALREADY whatever text belongs in the slashes — a
   * literal's own written text unchanged, or a regex.new value's
   * EscapeRegExpPattern-normalised text (design §5.6) — this method does
   * not re-derive or re-check either; it only reads the two fields and
   * assembles the four pieces directly (one allocation, two array.copys
   * — no generic 2-arg concat helper needed, and none of RegexBuilder's
   * OWN dependencies currently include one; a `new` allocation sized
   * `1 + sourceLen + 1 + flagsLen` up front, per-field arrayCopy into
   * the right offset, mirrors strings.ts's own pad()/emitCopySpan
   * precedent exactly). */
  inspectHelper(): number {
    if (this.inspectFn !== null) return this.inspectFn;
    const idx = this.mb.declareFunc(this.mb.funcType([this.regexRef()], [this.strRef()]), "%w.re.inspect");
    this.inspectFn = idx;
    const c = new Code();
    const RE = 0;
    const SRC = 1;
    const FLAGS = 2;
    const SL = 3;
    const FL = 4;
    const R = 5;
    c.localGet(RE);
    c.structGet(this.regexType, 0);
    c.localSet(SRC);
    c.localGet(RE);
    c.structGet(this.regexType, 1);
    c.localSet(FLAGS);
    c.localGet(SRC);
    c.arrayLen();
    c.localSet(SL);
    c.localGet(FLAGS);
    c.arrayLen();
    c.localSet(FL);
    // R = new str[1 + SL + 1 + FL]
    c.i32Const(2);
    c.localGet(SL);
    c.i32Add();
    c.localGet(FL);
    c.i32Add();
    c.arrayNewDefault(this.strType);
    c.localSet(R);
    // R[0] = '/'
    c.localGet(R);
    c.i32Const(0);
    c.i32Const(0x2f);
    c.arraySet(this.strType);
    // R[1, 1+SL) = SRC
    c.localGet(R);
    c.i32Const(1);
    c.localGet(SRC);
    c.i32Const(0);
    c.localGet(SL);
    c.arrayCopy(this.strType, this.strType);
    // R[1+SL] = '/'
    c.localGet(R);
    c.i32Const(1);
    c.localGet(SL);
    c.i32Add();
    c.i32Const(0x2f);
    c.arraySet(this.strType);
    // R[2+SL, 2+SL+FL) = FLAGS
    c.localGet(R);
    c.i32Const(2);
    c.localGet(SL);
    c.i32Add();
    c.localGet(FLAGS);
    c.i32Const(0);
    c.localGet(FL);
    c.arrayCopy(this.strType, this.strType);
    c.localGet(R);
    this.mb.setBody(idx, [this.strRef(), this.strRef(), I32, I32, this.strRef()], c.bytes());
    return idx;
  }
}
