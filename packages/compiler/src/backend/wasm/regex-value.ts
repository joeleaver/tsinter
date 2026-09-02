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

  readonly regexType: number;
  // Public: the ONE nominal bytecode array type this module's regex
  // values are built with. RegexInterpreterBuilder needs the SAME type
  // index (not a structurally-identical second one) to accept a
  // bytecode ref pulled via struct.get on a %w.re.Regex value — its own
  // constructor's injectedBcType param exists for exactly this (mirrors
  // the injectedCasing precedent already there).
  readonly bcType: number;
  private readonly strArrType: number;

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
}
