/* INC-24 P1, CP4: the wasm-emitted backtracking regex interpreter — a
 * transcription of lre_exec_backtrack (libregexp.c:2784-3333) and its
 * lre_exec wrapper (libregexp.c:3338-3376). Per design §2.1: one
 * function, %w.re.exec(bytecodeArray, subject, startIndex, captureOut)
 * -> i32, emitted lazily per module (this file's RegexInterpreterBuilder,
 * sibling to CasingBuilder/InspectBuilder). Per §7.1 the P1 gate is
 * "unit tests only" — this is NOT wired into any libCall/emitter path
 * yet; it is tested standalone (wasm-regex-interpreter.test.ts), the
 * same way casing.ts's own Stage-A was.
 *
 * DATA MODEL — the four translations from C's pointer/bitfield world to
 * wasm's GC-array world, each a DELIBERATE choice, recorded so a later
 * reader doesn't mistake them for missing transcription:
 *
 *   (1) cptr (C: a raw byte/halfword POINTER into the subject buffer) ->
 *       an i32 ELEMENT INDEX into the subject array. S002 fixes the
 *       subject representation to (array (mut i16)) — one array slot
 *       per UTF-16 code unit, ALWAYS (no cbuf_type==0 8-bit path is
 *       needed or built: this port's strings are never byte-packed).
 *       So `cptr == cbuf_end` becomes `idx == subject.length`, and the
 *       only remaining cbuf_type distinction is 1 (non-unicode: never
 *       combine surrogates) vs 2 (unicode: GET_CHAR/PREV_CHAR combine an
 *       adjacent surrogate pair into one astral code point) — which
 *       collapses to a single `isUnicode: i32` boolean local, read once
 *       from the bytecode header's flags word at the top of exec().
 *
 *   (2) capture[2*i]/capture[2*i+1] (C: POINTERS, NULL = unset) -> an
 *       (array (mut i32)) of length 2*captureCount, caller-allocated
 *       (newCaptureArray()) and caller-owned, exactly matching lre_exec's
 *       own `uint8_t **capture` being the CALLER's buffer. -1 is the
 *       "unset" sentinel (0 is a valid subject index, so it cannot serve
 *       double duty as NULL the way a C pointer can).
 *
 *   (3) StackElem (C: a tagged union — either a raw `ptr`, a plain
 *       `intptr_t val`, or the packed bp bitfield {val, type}, ALL
 *       sized to fit one machine word) -> every backtrack-stack SLOT is
 *       a plain i32, and the bp bitfield is NOT bit-packed — it becomes
 *       TWO separate i32 slots (bpVal, bpType) instead of one packed
 *       word. This is a pure C memory-layout optimization with no
 *       semantic content (bit-packing two small integers into one word
 *       to save space in a native heap allocation), so unpacking it
 *       does not violate the 1:1 transcription mandate (which binds
 *       SEMANTIC decisions, not this kind of C-specific storage
 *       trick) — the same judgment call RegexByteWriter already made
 *       for DynBuf's capacity bookkeeping in CP3. Consequence: a
 *       "capture save" entry is 2 slots (idx, oldValue) UNCHANGED from
 *       the C shape; a "backtrack point" entry (split/lookahead) is 4
 *       slots (pc, cptr, bpVal, bpType) instead of C's 3 (pc, cptr,
 *       bp-packed) — every `sp -= 3` / `sp[2].bp...` / `CHECK_STACK_
 *       SPACE(3)` site in the reference becomes `sp -= 4` / two
 *       separate slot reads / `ensureStackSpace(4)` in this port.
 *
 *   (4) stack_realloc (C: grow-by-1.5x + memcpy into a NEW malloc'd
 *       buffer, keeping `sp`/`bp` valid via saved-and-restored offsets)
 *       -> a GC array cannot be resized in place, so the SAME grow-by-
 *       1.5x discipline is done as: allocate a NEW (array (mut i32))
 *       of the larger size, array.copy the old contents in, rebind the
 *       `stack` local to the new array. `sp`/`bp` are already plain i32
 *       OFFSETS (not raw pointers) in this port, so — unlike the C
 *       version, which must explicitly save/restore them relative to a
 *       moving base pointer — they need no adjustment at all across a
 *       grow: an index into "the stack" stays correct regardless of
 *       which physical array backs it.
 *
 * BR_TABLE DISPATCH — the switch-lowering shape, verified by hand
 * before writing emitSwitch (not trusted from memory, per the F2-p3
 * lesson: "every hand-typed br depth is a bug waiting to happen — a
 * wrong one produces an infinite loop, not a validator error, and
 * vitest's own timeout cannot interrupt a synchronous wasm loop").
 * N opcode cases + 1 default = N+1 nested `block`s, opened OUTERMOST
 * FIRST: default, case[N-1], case[N-2], ..., case[1], case[0] — so
 * case[0] ends up innermost (depth 0 at the br_table site), case[i] is
 * depth i, default is depth N. Cases are then closed and their bodies
 * emitted in order 0..N-1 (case k's body sits immediately after
 * case[k]'s own `end`, exactly where the br_table's jump to depth k
 * lands); a case body that wants to "continue the dispatch loop" calls
 * `br(N - k)` AT THAT POINT (after k+1 blocks have been closed: k
 * case-blocks below it plus its own), which the trace below confirms is
 * always the enclosing `loop`'s current relative depth. This is
 * COMPUTED by emitSwitch's own loop counter, never hand-typed per case.
 *
 * OPCODE COVERAGE, THIS PASS: char/char_i/char32/char32_i, dot, any,
 * space, not_space, line_start(_m), line_end(_m), word_boundary(_i),
 * not_word_boundary(_i), save_start, save_end, save_reset, range(_i),
 * range32(_i), split_goto_first, split_next_first, goto, match, prev —
 * enough for the majority of real patterns (literals, classes, `a*`/
 * `a+`/`a?`-shaped quantifiers which compile via split+goto per CP3's
 * own emitQuantifier, alternation, capturing groups, anchors, word
 * boundaries). DEFERRED to the next slice, and TRAPPING (unreachable)
 * rather than silently miscompiling if reached: lookahead/negative_
 * lookahead + their _match counterparts, set_i32/set_char_pos/
 * check_advance, the loop family (loop, loop_split_goto_first,
 * loop_split_next_first, loop_check_adv_split_goto_first,
 * loop_check_adv_split_next_first — bounded-count quantifiers such as
 * an exact-N or an M-to-N repeat), and the back_reference family
 * (back_reference, back_reference_i, backward_back_reference,
 * backward_back_reference_i).
 *
 * STANDING STYLE, RATIFIED (lead, this increment): every opcode handler
 * in this file is written as a LINEAR default-then-conditionally-
 * override sequence — compute the "nothing special happened" answer
 * first, THEN one or more `ifVoid` blocks OVERWRITE specific locals if
 * a condition holds — never as nested `ifResult` expression trees. This
 * is deliberate, not a style preference some handlers happened to
 * follow: getChar's own doc comment records the first (nested-
 * expression) draft as a genuinely broken, hard-to-verify mess, thrown
 * away and rewritten in this linear shape before ever being tested. The
 * NEXT reader (including a review gate reading this file cold) should
 * take the linear shape as the intended contract, not an accident one
 * function happened to land in. */
import { I32, type ModuleBuilder, type ValType } from "./module.js";
import { Code } from "./code.js";
import { REOP, RE_HEADER_FLAGS, RE_HEADER_CAPTURE_COUNT, RE_HEADER_LEN, LRE_FLAG_UNICODE, LRE_FLAG_UNICODE_SETS } from "./regex-opcodes.js";
import { CasingBuilder } from "./casing.js";
import { emitRange } from "./regex-assembler.js";
import { RegexByteWriter } from "./regex-bytewriter.js";
import { classRangeDSW, type CharRange } from "./regex-charclass.js";

/** A FIXED, compile-time-embedded range table — this port's own answer
 * to REOP_space/REOP_not_space carrying no per-instance bytecode
 * operand (see buildFixedRangeTable's own doc comment). */
interface FixedRangeTable {
  readonly offset: number; // data-segment byte offset (mb.internData)
  readonly length: number; // byte length of the raw (low,high) pairs, no opcode/len prefix
  readonly n: number; // pair count
  readonly is32: boolean; // which width emitRange chose for this CharRange
}

/** REExecStateEnum (libregexp.c:2714-2718) — tags on each backtrack-
 * point stack entry recording WHICH construct pushed it, read back by
 * no_match to decide whether to keep unwinding (a LOOKAHEAD entry is
 * always skipped over — its own REOP_lookahead_match/negative_
 * lookahead_match opcodes handle it, not a plain match failure) or
 * stop (any other type is a genuine backtrack point). Values match the
 * C enum's declaration order exactly (0,1,2, the default for an
 * unspecified C enum). */
const RE_EXEC_STATE_SPLIT = 0;
const RE_EXEC_STATE_LOOKAHEAD = 1;
const RE_EXEC_STATE_NEGATIVE_LOOKAHEAD = 2;

/* emitSwitch's own dispatch mechanism is now PROVEN correct through
 * actual WebAssembly execution (wasm-regex-interpreter-core.test.ts's
 * testDispatchLoop suite — 7 pins, all under an external timeout,
 * covering: each case individually, all three in sequence, a repeated
 * case, terminator-first, and reversed order as a control against a
 * hidden case-index-dependent bug) — not just the hand-traced formula
 * in this file's own header. exec() below builds on top of it with
 * that confidence. STILL NOT YET IMPORTED/BUILT (the CP_LF/CP_CR/CP_LS/
 * CP_PS line-terminator constants and an emitIsWordByte helper) because
 * this slice's opcode set (below) doesn't reach line_start/line_end/
 * word_boundary yet — same "nothing untested sits here" discipline. */

export class RegexInterpreterBuilder {
  private readonly bcType: number; // (array (mut i8)) — the bytecode
  private readonly capType: number; // (array (mut i32)) — capture[] and the backtrack stack (same element shape, different arrays)
  private readonly fns = new Map<string, number>();
  // CASINGBUILDER DEDUP RULING (CP4 back half, measured at embedding):
  // an INJECTED CasingBuilder, when the caller already has one (as
  // emitter.ts's own `get casing()` does — this is the intended
  // production path once a `get regex()` accessor wires this class up
  // there), else lazily self-constructed (every existing test harness's
  // own `new RegexInterpreterBuilder(mb, strType)`, two-arg, unaffected
  // — this parameter is additive). MEASURED, not assumed: a SECOND,
  // independent CasingBuilder instance in the same module costs 978
  // bytes of DUPLICATED CODE (its own 7 null-init globals + the
  // %w.str.caseInit guard + caseConvCp's own function body) — the
  // underlying TABLE DATA itself already dedupes via internData's
  // exact-match dedup regardless of instance count, so this 978 is
  // the FULL, exact cost sharing avoids, not an estimate. RULED:
  // share. A module compiling both ordinary string case conversion
  // (String.prototype.toUpperCase/toLowerCase) and an ignoreCase regex
  // — a common combination — pays this cost needlessly on every build
  // otherwise, for zero functional difference either way.
  private casingField: CasingBuilder | null;
  private readonly spaceTable: FixedRangeTable;
  private readonly notSpaceTable: FixedRangeTable;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number, // (array (mut i16)), S002's shared subject-string type
    injectedCasing?: CasingBuilder,
  ) {
    this.casingField = injectedCasing ?? null;
    this.bcType = mb.arrayType("i8", false);
    this.capType = mb.arrayType(I32, true);
    // classRangeDSW("s")/("S") is the SAME \s/\S CharRange this port's
    // own charclass machinery already uses (and has already had
    // gate-verified) for a BRACKETED \s (e.g. `[\s\d]`) — reusing it
    // here means REOP_space/not_space's fixed table is never a second,
    // independently-derived whitespace set that could quietly drift
    // from the one the rest of this port trusts.
    this.spaceTable = this.buildFixedRangeTable(classRangeDSW("s"));
    this.notSpaceTable = this.buildFixedRangeTable(classRangeDSW("S"));
  }

  /** Builds a FIXED range table for REOP_space/REOP_not_space (see
   * FixedRangeTable's own doc comment on why they need one at all) by
   * reusing regex-assembler.ts's emitRange — ALREADY oracle-verified
   * (CP3's gate leg) — into a SCRATCH RegexByteWriter, then stripping
   * its 3-byte instruction PREFIX (1 opcode + u16 len): the runtime
   * here never reads an opcode or an embedded length back out of these
   * tables (n travels as a separate compile-time-known i32 CONSTANT,
   * not read from the array), it only wants the raw sorted (low,high)
   * pairs that follow. `is32` is read back from WHICH opcode emitRange
   * actually chose (REOP_range vs REOP_range32) rather than re-deriving
   * its own width-decision threshold a second time by hand. */
  private buildFixedRangeTable(cr: CharRange): FixedRangeTable {
    const w = new RegexByteWriter();
    emitRange(w, cr, false); // \s/\S are never case-folded — see walkTerm's own note (there isn't a "_i" variant)
    const all = w.toBytes();
    const opcode = w.byteAt(0);
    const n = w.readU16(1);
    const bytes = all.slice(3);
    const offset = this.mb.internData(bytes);
    return { offset, length: bytes.length, n, is32: opcode === REOP.range32 };
  }

  /** ECMA Default Case Conversion (casing.ts) — the constructor's own
   * injectedCasing param (see its doc comment: the CasingBuilder dedup
   * ruling) is preferred when present; otherwise lazily self-
   * instantiated here, mirroring emitter.ts's own `get casing()`
   * exactly. Only regexCanonicalize() below reaches for it, so a
   * module whose regex corpus never uses /i never pays for
   * materializing the case tables at runtime (ensureInit()'s own lazy
   * guard) — though the wasm CODE for canonicalize() itself is always
   * compiled in, since exec() is one monolithic dispatch function
   * covering every opcode this slice supports, not a per-construct-
   * selected build. */
  private get casing(): CasingBuilder {
    this.casingField ??= new CasingBuilder(this.mb, this.strType);
    return this.casingField;
  }

  private cached(name: string, build: () => number): number {
    const existing = this.fns.get(name);
    if (existing !== undefined) return existing;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  private capRefType(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.capType };
  }
  private bcRefType(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.bcType };
  }
  private strRefType(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  /** newCaptureArray(count: i32) -> (array (mut i32)) of length 2*count,
   * every slot initialized to -1 (matching lre_exec's own `capture[i] =
   * NULL` loop, libregexp.c:3360-3361 — this port's "unset" sentinel).
   * arrayNewDefault zero-fills, so an explicit fill-with(-1) loop
   * follows — there is no `array.fill` in this codebase's Code (per the
   * code.ts survey), so this is a hand-written loop, not a builtin. */
  newCaptureArray(): number {
    return this.cached("newCaptureArray", () => {
      const COUNT = 0;
      const ARR = 1;
      const I = 2;
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [this.capRefType()]), "%w.re.newCaptureArray");
      const c = new Code();
      c.localGet(COUNT);
      c.i32Const(2);
      c.i32Mul();
      c.arrayNewDefault(this.capType);
      c.localSet(ARR);
      c.i32Const(0);
      c.localSet(I);
      c.loop();
      c.localGet(I);
      c.localGet(ARR);
      c.arrayLen();
      c.i32GeS();
      c.ifVoid();
      c.localGet(ARR);
      c.return_();
      c.end();
      c.localGet(ARR);
      c.localGet(I);
      c.i32Const(-1);
      c.arraySet(this.capType);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.localGet(ARR);
      this.mb.setBody(idx, [this.capRefType(), I32], c.bytes());
      return idx;
    });
  }

  /** readU8/readU16/readU32 — little-endian operand reads from the
   * bytecode array at a given position, matching RegexByteWriter's own
   * readU16/readU32 (regex-bytewriter.ts) but reading from a wasm GC
   * array instead of a JS number[]. Each returns a FUNCTION INDEX
   * (declared once, cached) taking (bc, pos) as its OWN wasm-level
   * params — this TS method has no parameters itself, it just builds
   * (or returns the already-built) callee. */
  readU8(): number {
    return this.cached("readU8", () => {
      const BC = 0;
      const POS = 1;
      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType(), I32], [I32]), "%w.re.readU8");
      const c = new Code();
      c.localGet(BC);
      c.localGet(POS);
      c.arrayGetU(this.bcType);
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  readU16(): number {
    return this.cached("readU16", () => {
      const BC = 0;
      const POS = 1;
      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType(), I32], [I32]), "%w.re.readU16");
      const c = new Code();
      c.localGet(BC);
      c.localGet(POS);
      c.arrayGetU(this.bcType);
      c.localGet(BC);
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.bcType);
      c.i32Const(8);
      c.i32Shl();
      c.i32Or();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  readU32(): number {
    return this.cached("readU32", () => {
      const BC = 0;
      const POS = 1;
      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType(), I32], [I32]), "%w.re.readU32");
      const c = new Code();
      for (let byteIdx = 0; byteIdx < 4; byteIdx++) {
        c.localGet(BC);
        c.localGet(POS);
        if (byteIdx > 0) {
          c.i32Const(byteIdx);
          c.i32Add();
        }
        c.arrayGetU(this.bcType);
        if (byteIdx > 0) {
          c.i32Const(byteIdx * 8);
          c.i32Shl();
        }
        if (byteIdx > 0) c.i32Or();
      }
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** ensureStackSpace(stack, sp, needed) -> possibly-NEW stack array,
   * grown to hold at least `needed` more slots past `sp` — the wasm
   * equivalent of stack_realloc (libregexp.c:2760-2781): grow-by-1.5x
   * (clamped up to whatever `needed` actually requires), copy the
   * VALID prefix [0, sp) into the new array, return it. Per this file's
   * own header (translation 4): sp/bp are already plain offsets, not
   * raw pointers, so — unlike the C version — nothing else needs
   * adjusting across a grow; the caller just rebinds its `stack` local
   * to this function's return value. */
  ensureStackSpace(): number {
    return this.cached("ensureStackSpace", () => {
      const STACK = 0;
      const SP = 1;
      const NEEDED = 2;
      const NEW_LEN = 3;
      const NEW_STACK = 4;
      const idx = this.mb.declareFunc(this.mb.funcType([this.capRefType(), I32, I32], [this.capRefType()]), "%w.re.ensureStackSpace");
      const c = new Code();
      // if (stack.len - sp) >= needed: return stack (fast path, no grow)
      c.localGet(STACK);
      c.arrayLen();
      c.localGet(SP);
      c.i32Sub();
      c.localGet(NEEDED);
      c.i32GeS();
      c.ifVoid();
      c.localGet(STACK);
      c.return_();
      c.end();
      // newLen = max(stack.len * 3 / 2, sp + needed)
      c.localGet(STACK);
      c.arrayLen();
      c.i32Const(3);
      c.i32Mul();
      c.i32Const(2);
      c.i32DivS();
      c.localGet(SP);
      c.localGet(NEEDED);
      c.i32Add();
      c.localTee(NEW_LEN); // stash sp+needed while comparing
      c.i32GeS(); // (len*3/2) >= (sp+needed) ?
      c.ifVoid();
      c.localGet(STACK);
      c.arrayLen();
      c.i32Const(3);
      c.i32Mul();
      c.i32Const(2);
      c.i32DivS();
      c.localSet(NEW_LEN);
      c.end();
      c.localGet(NEW_LEN);
      c.arrayNewDefault(this.capType);
      c.localSet(NEW_STACK);
      c.localGet(NEW_STACK);
      c.i32Const(0);
      c.localGet(STACK);
      c.i32Const(0);
      c.localGet(SP);
      c.arrayCopy(this.capType, this.capType);
      c.localGet(NEW_STACK);
      this.mb.setBody(idx, [I32, this.capRefType()], c.bytes());
      return idx;
    });
  }

  /** saveCaptureCheck(stack, sp, bp, captureOut, idx, value) ->
   * (newStack, newSp) — SAVE_CAPTURE_CHECK (libregexp.c:2824-2843),
   * NOT SAVE_CAPTURE: "avoid saving the previous value if already
   * saved". Scans BACKWARD from sp toward bp, 2 slots at a time,
   * looking for an EXISTING undo entry for this idx WITHIN the current
   * [bp, sp) segment only (the scan stops at bp, never looks further
   * back); if found, no new entry is pushed (stack/sp UNCHANGED) —
   * only capture[idx] is overwritten. Only once the scan reaches bp
   * without a match does it fall through to push a NEW 2-slot entry,
   * exactly like SAVE_CAPTURE. This is what keeps a bounded-count
   * quantifier's own counter register from growing the backtrack stack
   * without bound on every pass: repeated writes to the SAME register
   * between backtrack points collapse into ONE undo entry (the first
   * one, holding the value from before ANY of this segment's writes —
   * exactly what a full backtrack past this segment needs; the later,
   * superseded writes have nothing left to undo once that first entry
   * exists). noMatch's own generic 2-slot undo-pop loop needs ZERO
   * changes to support this: a register-save entry is structurally
   * IDENTICAL to an ordinary capture-save entry, idx-agnostic already.
   *
   * The "found" path is an EARLY RETURN (safe regardless of block
   * nesting — the same idiom newCaptureArray's own fill loop already
   * established), not a flag threaded back out through the loop. */
  saveCaptureCheck(): number {
    return this.cached("saveCaptureCheck", () => {
      const STACK = 0;
      const SP = 1;
      const BP = 2;
      const CAPTURE_OUT = 3;
      const IDX = 4;
      const VALUE = 5;
      const SP1 = 6;
      const NEW_STACK = 7;
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.capRefType(), I32, I32, this.capRefType(), I32, I32], [this.capRefType(), I32]),
        "%w.re.saveCaptureCheck",
      );
      const c = new Code();
      c.localGet(SP);
      c.localSet(SP1);
      c.loop();
      c.localGet(SP1);
      c.localGet(BP);
      c.i32GtS();
      c.ifVoid();
      // sp1 > bp: does the entry at [sp1-2] match idx?
      c.localGet(STACK);
      c.localGet(SP1);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localGet(IDX);
      c.i32Eq();
      c.ifVoid();
      // FOUND: no push needed — stack/sp unchanged, just write.
      c.localGet(CAPTURE_OUT);
      c.localGet(IDX);
      c.localGet(VALUE);
      c.arraySet(this.capType);
      c.localGet(STACK);
      c.localGet(SP);
      c.return_();
      c.end();
      // not found here: sp1 -= 2, continue the scan.
      c.localGet(SP1);
      c.i32Const(2);
      c.i32Sub();
      c.localSet(SP1);
      c.br(1); // continue the scan loop
      c.end();
      // sp1 <= bp: exhausted the segment — fall through (do NOT loop again).
      c.end(); // loop
      // EXHAUSTED: push a new 2-slot entry, same shape as SAVE_CAPTURE.
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(2);
      c.call(this.ensureStackSpace());
      c.localSet(NEW_STACK);
      c.localGet(NEW_STACK);
      c.localGet(SP);
      c.localGet(IDX);
      c.arraySet(this.capType);
      c.localGet(NEW_STACK);
      c.localGet(SP);
      c.i32Const(1);
      c.i32Add();
      c.localGet(CAPTURE_OUT);
      c.localGet(IDX);
      c.arrayGet(this.capType);
      c.arraySet(this.capType);
      c.localGet(CAPTURE_OUT);
      c.localGet(IDX);
      c.localGet(VALUE);
      c.arraySet(this.capType);
      c.localGet(NEW_STACK);
      c.localGet(SP);
      c.i32Const(2);
      c.i32Add();
      this.mb.setBody(idx, [I32, this.capRefType()], c.bytes());
      return idx;
    });
  }

  /** getChar(subject, idx, isUnicode) -> (codePoint, newIdx), a TWO-
   * RESULT function — GET_CHAR (libregexp.c:2631-2648) ADVANCING idx:
   * reads subject[idx]; under isUnicode, if it's a high surrogate AND
   * idx+1 is a valid low surrogate, combines them into one astral code
   * point and advances idx by 2; otherwise advances by 1 with no
   * combination. This is this port's cbuf_type collapse (file header,
   * translation 1): the ONLY cbuf_type distinction that survives is
   * isUnicode, since the subject array is ALWAYS i16-per-code-unit
   * (never byte-packed). Written as a LINEAR default-then-conditionally-
   * override sequence (compute (cp=hi, newIdx=idx+1) as the default,
   * THEN one `ifVoid` overwrites both locals if the combine condition
   * holds) rather than nested `ifResult` expressions — far easier to
   * get right and to verify by inspection; the nested-expression
   * version of this function was written first, found to be an
   * unreadable mess with an inconsistent final comment about its own
   * stack order, and thrown away rather than debugged in place. */
  getChar(): number {
    return this.cached("getChar", () => {
      const SUBJECT = 0;
      const IDX = 1;
      const IS_UNICODE = 2;
      const HI = 3;
      const LO = 4;
      const CP = 5;
      const NEW_IDX = 6;
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRefType(), I32, I32], [I32, I32]), "%w.re.getChar");
      const c = new Code();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.arrayGetU(this.strType);
      c.localSet(HI);
      // Defaults: no combination.
      c.localGet(HI);
      c.localSet(CP);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localSet(NEW_IDX);
      // Guard: isUnicode && isHiSurrogate(hi) && (idx+1 < subject.len)
      c.localGet(IS_UNICODE);
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(HI);
      c.i32Const(0xdc00);
      c.i32LtU();
      c.i32And();
      c.i32And();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(SUBJECT);
      c.arrayLen();
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.localSet(LO);
      // Inner guard: isLoSurrogate(lo)
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(LO);
      c.i32Const(0xe000);
      c.i32LtU();
      c.i32And();
      c.ifVoid();
      // Overwrite the defaults: combine, advance by 2.
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(0x400);
      c.i32Mul();
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.i32Const(0x10000);
      c.i32Add();
      c.localSet(CP);
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Add();
      c.localSet(NEW_IDX);
      c.end(); // inner ifVoid
      c.end(); // outer ifVoid
      // Results are popped by the caller in REVERSE declaration order
      // (casing.ts's own convention, per the module survey): funcType
      // declares [codePoint, newIdx], so the LAST value pushed here
      // (newIdx) is what the caller's FIRST localSet reads.
      c.localGet(CP);
      c.localGet(NEW_IDX);
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** peekChar(subject, idx, isUnicode) -> codePoint — PEEK_CHAR
   * (libregexp.c:2648-2662): the SAME combine logic as getChar, but
   * does NOT advance/return idx (used where the reference reads a
   * character to TEST without consuming it — REOP_dot/REOP_line_end's
   * own "what's at cptr" checks that don't move cptr on their own,
   * REOP_word_boundary's "current char" half). Literally getChar's own
   * body with the newIdx half removed — kept as a SEPARATE function
   * (not getChar-plus-discard-the-second-result) because a caller that
   * only wants the codepoint shouldn't have to thread an unused idx
   * result through localSets it never reads. */
  peekChar(): number {
    return this.cached("peekChar", () => {
      const SUBJECT = 0;
      const IDX = 1;
      const IS_UNICODE = 2;
      const HI = 3;
      const LO = 4;
      const CP = 5;
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRefType(), I32, I32], [I32]), "%w.re.peekChar");
      const c = new Code();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.arrayGetU(this.strType);
      c.localSet(HI);
      c.localGet(HI);
      c.localSet(CP); // default: no combination
      c.localGet(IS_UNICODE);
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(HI);
      c.i32Const(0xdc00);
      c.i32LtU();
      c.i32And();
      c.i32And();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localGet(SUBJECT);
      c.arrayLen();
      c.i32LtS();
      c.i32And();
      c.ifVoid();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.localSet(LO);
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(LO);
      c.i32Const(0xe000);
      c.i32LtU();
      c.i32And();
      c.ifVoid();
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(0x400);
      c.i32Mul();
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.i32Const(0x10000);
      c.i32Add();
      c.localSet(CP);
      c.end();
      c.end();
      c.localGet(CP);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** peekPrevChar(subject, idx, isUnicode) -> codePoint — PEEK_PREV_CHAR
   * (libregexp.c:2664-2678): reads the char immediately BEFORE idx
   * (idx-1), combining BACKWARD with idx-2 as the high surrogate under
   * isUnicode, WITHOUT moving idx. Used by REOP_line_start_m and
   * REOP_word_boundary's own "char before cptr" half. */
  peekPrevChar(): number {
    return this.cached("peekPrevChar", () => {
      const SUBJECT = 0;
      const IDX = 1;
      const IS_UNICODE = 2;
      const LO = 3;
      const HI = 4;
      const CP = 5;
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRefType(), I32, I32], [I32]), "%w.re.peekPrevChar");
      const c = new Code();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(LO);
      c.localGet(LO);
      c.localSet(CP); // default: no combination
      // Guard: isUnicode && isLoSurrogate(lo) && (idx-2 >= 0)
      c.localGet(IS_UNICODE);
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(LO);
      c.i32Const(0xe000);
      c.i32LtU();
      c.i32And();
      c.i32And();
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Sub();
      c.i32Const(0);
      c.i32GeS();
      c.i32And();
      c.ifVoid();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(HI);
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(HI);
      c.i32Const(0xdc00);
      c.i32LtU();
      c.i32And();
      c.ifVoid();
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(0x400);
      c.i32Mul();
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.i32Const(0x10000);
      c.i32Add();
      c.localSet(CP);
      c.end();
      c.end();
      c.localGet(CP);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** prevChar(subject, idx, isUnicode) -> newIdx — PREV_CHAR
   * (libregexp.c:2698-2712): moves idx BACKWARD by one character,
   * combining with idx-2 as the high surrogate under isUnicode (SAME
   * backward-combine condition as peekPrevChar, just returning the new
   * position instead of the codepoint at it). Used by REOP_prev
   * directly, and — once lookbehind lands — by the backward-direction
   * body-walking machinery generally. */
  prevChar(): number {
    return this.cached("prevChar", () => {
      const SUBJECT = 0;
      const IDX = 1;
      const IS_UNICODE = 2;
      const LO = 3;
      const HI = 4;
      const NEW_IDX = 5;
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRefType(), I32, I32], [I32]), "%w.re.prevChar");
      const c = new Code();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(LO);
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(NEW_IDX); // default: back up by one code unit
      c.localGet(IS_UNICODE);
      c.localGet(LO);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(LO);
      c.i32Const(0xe000);
      c.i32LtU();
      c.i32And();
      c.i32And();
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Sub();
      c.i32Const(0);
      c.i32GeS();
      c.i32And();
      c.ifVoid();
      c.localGet(SUBJECT);
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(HI);
      c.localGet(HI);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(HI);
      c.i32Const(0xdc00);
      c.i32LtU();
      c.i32And();
      c.ifVoid();
      c.localGet(IDX);
      c.i32Const(2);
      c.i32Sub();
      c.localSet(NEW_IDX);
      c.end();
      c.end();
      c.localGet(NEW_IDX);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** popBacktrackEntry(stack, sp, bp, captureOut) -> (pc, cptr, newBp,
   * newSp, type) — the SHARED per-iteration body noMatch's own pop-loop
   * needs for EVERY (compareType, continueOnEqual) it's parameterized
   * over (findings-p1-v1.txt's own design-trace entry has the full
   * history: an earlier draft built a SEPARATE dedicated loop for the
   * negative-lookahead unwind instead of parameterizing noMatch, per
   * the lead's own leaning at the time; the lead's FINAL ruling
   * reconsidered that, since noMatch's own loop and the negative-
   * lookahead unwind share their ENTIRE per-iteration body — legitimate
   * parameterization, not the \S-style conflation of merged MECHANISMS
   * the leaning was guarding against — even though it turned out to
   * need TWO varying parameters, not the one originally estimated; see
   * noMatch's own doc comment for why). Runs the "undo
   * capture modifications" while-loop (captureOut[stack[sp-2]] =
   * stack[sp-1]; sp -= 2, while sp>bp — this ALWAYS terminates with
   * sp==bp exactly, a structural invariant of how captures are pushed
   * in 2s and markers in 4s with bp tracking marker boundaries, not an
   * assumption), THEN reads the 4-slot backtrack-point marker now
   * sitting at [sp-4,sp) (this port's UNPACKED equivalent of C's 3-slot
   * {ptr,ptr,bp-bitfield} — see this file's own header, translation 3),
   * restores bp from the marker's own bpVal field, and pops it (sp -=
   * 4). Deliberately does NOT decide continue-vs-stop: that decision is
   * exactly what noMatch's own compareType/continueOnEqual parameters
   * vary — sharing the BODY here is economy; sharing that CONTROL is
   * what those parameters now do explicitly, not silently. */
  private popBacktrackEntry(): number {
    return this.cached("popBacktrackEntry", () => {
      const STACK = 0;
      const SP = 1;
      const BP = 2;
      const CAPTURE_OUT = 3;
      const PC_OUT = 4;
      const CPTR_OUT = 5;
      const TYPE_OUT = 6;
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.capRefType(), I32, I32, this.capRefType()], [I32, I32, I32, I32, I32]),
        "%w.re.popBacktrackEntry",
      );
      const c = new Code();
      // undo: while (sp > bp) { captureOut[stack[sp-2]] = stack[sp-1]; sp -= 2; }
      c.loop();
      c.localGet(SP);
      c.localGet(BP);
      c.i32GtS();
      c.ifVoid();
      c.localGet(CAPTURE_OUT);
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.arraySet(this.capType);
      c.localGet(SP);
      c.i32Const(2);
      c.i32Sub();
      c.localSet(SP);
      c.br(1); // continue the undo loop
      c.end();
      c.end(); // undo loop closes — sp == bp now, exactly
      // Restore (pc, cptr, bp, type) from the 4-slot entry at [sp-4,sp),
      // then pop it (sp -= 4). `bp` is overwritten directly: MY bp is
      // already a plain offset (not a pointer), so this is just
      // `bp = stack[sp-2]`, no "stack_buf +" needed the way C's
      // `bp = s->stack_buf + sp[-1].bp.val` requires.
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(4);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(PC_OUT);
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(3);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(CPTR_OUT);
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(TYPE_OUT);
      c.localGet(STACK);
      c.localGet(SP);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(BP); // newBp
      c.localGet(SP);
      c.i32Const(4);
      c.i32Sub();
      c.localSet(SP); // newSp
      c.localGet(PC_OUT);
      c.localGet(CPTR_OUT);
      c.localGet(BP);
      c.localGet(SP);
      c.localGet(TYPE_OUT);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** no_match (libregexp.c:2862-2883), the generic backtrack-pop loop —
   * built as its OWN callable function, not inlined into exec()'s
   * dispatch loop, so it can be proven against a SYNTHETIC pre-built
   * stack BEFORE exec() ever calls it — the lead named this the
   * highest-risk hand-built control flow in the whole port, so it gets
   * the SAME "prove the mechanism first" treatment emitSwitch/
   * testDispatchLoop already earned.
   *
   * PARAMETERIZED with compareType/continueOnEqual — REVISED per the
   * lead's own explicit ruling, overruling their EARLIER leaning toward
   * a dedicated second loop for negative_lookahead_match: this loop and
   * that one share their ENTIRE per-iteration BODY (via
   * popBacktrackEntry) — the lead's own conflation concern (echoing \S's
   * double-inversion bug) applies to MERGED MECHANISMS, not a shared
   * body with varying parameters, and this IS parameterization's
   * legitimate case, not that conflation shape.
   *
   * TWO params vary, not one — caught by ACTUALLY BUILDING the first
   * (single-stopType) attempt and running its pins, not assumed from
   * the design alone: no_match's own loop (libregexp.c:2862-2883) skips
   * past ONE specific type (LOOKAHEAD) and stops on EVERYTHING else —
   * `if (type != LOOKAHEAD) break`. negative_lookahead_match's own
   * unwind (libregexp.c:2917-2935) skips past EVERYTHING except one
   * specific type (NEGATIVE_LOOKAHEAD) and stops THERE specifically —
   * `if (type == NEGATIVE_LOOKAHEAD) break`. These are OPPOSITE-
   * POLARITY conditions relative to their own target constant (stop
   * when type != target vs stop when type == target) — a single
   * "stopType" value compared ONE way can express only one of the two
   * shapes, not both; continueOnEqual is the SECOND parameter this
   * turned out to need, selecting which comparison direction applies.
   * exec()'s own gotoNoMatch always passes (LOOKAHEAD, true) —
   * unchanged behavior, zero call-site drift for the pre-existing path;
   * emitNegativeLookaheadMatch's own FIRST call passes (NEGATIVE_
   * LOOKAHEAD, false) (see unwindToType's own doc comment on exec()'s
   * side). Signature change (4 params -> 6) is isolated and re-tested
   * BEFORE any new lookahead code landed on top of it — see findings-
   * p1-v1.txt's own design-trace entry for the full history (this
   * function's body was ALSO refactored earlier this same pass to call
   * popBacktrackEntry, itself isolated and re-tested separately from
   * THIS signature change).
   *
   * Params: stack, sp, bp, captureOut, compareType, continueOnEqual —
   * the same locals exec()'s dispatch loop holds for the first four
   * (sp/bp are read AND overwritten in place across iterations,
   * matching how a wasm param is just a mutable local). MUTATES
   * captureOut directly (the "undo capture modifications" step,
   * libregexp.c:2867-2871 — a GC ref array, no need to return it).
   * Returns (shouldReturn0, newPc, newCptr, newBp, newSp): shouldReturn0
   * =1 means bp reached the stack's base (no more backtrack points, a
   * genuine failure) — the caller must `return 0` immediately; 0 means
   * pc/cptr/bp/sp have been restored to the most recent backtrack point
   * whose own continue-condition was FALSE, and dispatch should resume
   * from there (pc already IS the retry target — re-enter the loop,
   * don't re-run anything).
   *
   * lre_poll_timeout's own call (libregexp.c:2881) is DELIBERATELY not
   * ported: a periodic interrupt-check for pathologically long matches,
   * not a correctness requirement, and §9.3's own stance is "no step
   * cap in this increment... exhaustion surfaces as a wasm trap" — there
   * is no interrupt mechanism here to poll into. */
  noMatch(): number {
    return this.cached("noMatch", () => {
      const STACK = 0;
      const SP = 1;
      const BP = 2;
      const CAPTURE_OUT = 3;
      const COMPARE_TYPE = 4;
      const CONTINUE_ON_EQUAL = 5;
      const PC_OUT = 6;
      const CPTR_OUT = 7;
      const TYPE = 8;
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.capRefType(), I32, I32, this.capRefType(), I32, I32], [I32, I32, I32, I32, I32]),
        "%w.re.noMatch",
      );
      const c = new Code();
      c.loop(); // outer: repeats only while the popped entry's own continue-condition holds
      c.localGet(BP);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(STACK);
      c.localGet(SP);
      c.localGet(BP);
      c.localGet(CAPTURE_OUT);
      c.call(this.popBacktrackEntry());
      // Results declared [pc, cptr, newBp, newSp, type] — popped in
      // REVERSE declaration order, this file's own established
      // convention (e.g. getChar's own doc comment).
      c.localSet(TYPE);
      c.localSet(SP);
      c.localSet(BP);
      c.localSet(CPTR_OUT);
      c.localSet(PC_OUT);
      // continue iff (type == compareType) == continueOnEqual — i.e.
      // when continueOnEqual is TRUE(1): continue while type MATCHES
      // (exec()'s own gotoNoMatch: skip past LOOKAHEAD markers, stop on
      // everything else); when continueOnEqual is FALSE(0): continue
      // while type does NOT match (the negative-lookahead unwind: skip
      // past EVERYTHING except its own marker, stop there specifically)
      // — see this function's own doc comment for why this SECOND
      // parameter turned out to be genuinely needed, not just one.
      // Comparing two i32 booleans for equality is the flat, no-short-
      // circuit-needed way to express that XOR-shaped condition.
      c.localGet(TYPE);
      c.localGet(COMPARE_TYPE);
      c.i32Eq();
      c.localGet(CONTINUE_ON_EQUAL);
      c.i32Eq();
      c.ifVoid();
      c.br(1); // continue the outer loop
      c.end();
      c.end(); // outer loop — reached ONLY via the natural-fallthrough (continue-condition false) exit
      c.i32Const(0);
      c.localGet(PC_OUT);
      c.localGet(CPTR_OUT);
      c.localGet(BP);
      c.localGet(SP);
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** lookaheadMatch(stack, sp, bp) -> (newStack, newPc, newCptr, newBp,
   * newSp) — REOP_lookahead_match (libregexp.c:2884-2916), a POSITIVE
   * lookahead's body having just succeeded. NOT a transcription of the
   * reference's own packed-pointer trick (findings-p1-v1.txt's own
   * design-trace entry has the full hand-traced equivalence proof and
   * states the CONTRACT this function preserves instead: the
   * reference's observable stack DISCIPLINE, not its C-internal storage
   * mechanism) — a SIMPLER, INCREMENTAL re-derivation: walk the bp chain
   * backward, and the MOMENT each backtrack-point marker is found,
   * immediately compact it away with ONE array.copy call (closing the 4-
   * slot gap it leaves), rather than C's own stash-then-second-pass.
   * Markers are discarded; the capture-save entries the lookahead's own
   * BODY pushed are PRESERVED (compacted, never undone — a successful
   * lookahead COMMITS its own capture writes, e.g. `(?=(a))b` must have
   * capture 1 set afterward). Stops at the FIRST LOOKAHEAD-type marker
   * found — by construction always THIS lookahead's own (a sibling or
   * nested lookahead's own _match would already have popped ITS OWN
   * marker before dispatch could reach here). No captureOut parameter:
   * this function never undoes anything, so it never touches it. No
   * ensureStackSpace call either: compaction only ever shrinks. */
  lookaheadMatch(): number {
    return this.cached("lookaheadMatch", () => {
      const STACK = 0;
      const SP = 1;
      const BP = 2;
      const TOP = 3;
      const CURSOR = 4;
      const PC_OUT = 5;
      const CPTR_OUT = 6;
      const TYPE = 7;
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.capRefType(), I32, I32], [this.capRefType(), I32, I32, I32, I32]),
        "%w.re.lookaheadMatch",
      );
      const c = new Code();
      c.localGet(SP);
      c.localSet(TOP);
      c.localGet(BP);
      c.localSet(CURSOR);
      c.loop();
      // read the marker at [CURSOR-4, CURSOR)
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.i32Const(4);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(PC_OUT);
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.i32Const(3);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(CPTR_OUT);
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(TYPE);
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGet(this.capType);
      c.localSet(BP); // bpValNext — this marker's own recorded outer bp
      // compact: shift [CURSOR, TOP) down to start at (CURSOR-4)
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.i32Const(4);
      c.i32Sub();
      c.localGet(STACK);
      c.localGet(CURSOR);
      c.localGet(TOP);
      c.localGet(CURSOR);
      c.i32Sub();
      c.arrayCopy(this.capType, this.capType);
      c.localGet(TOP);
      c.i32Const(4);
      c.i32Sub();
      c.localSet(TOP);
      c.localGet(BP);
      c.localSet(CURSOR); // move to the outer bp for the next iteration, if any
      // if type != LOOKAHEAD: keep searching (natural fallthrough on
      // the match is the "break" — the SAME idiom noMatch's own outer
      // loop already established, not a fresh invention).
      c.localGet(TYPE);
      c.i32Const(RE_EXEC_STATE_LOOKAHEAD);
      c.i32Ne();
      c.ifVoid();
      c.br(1); // continue the search loop
      c.end();
      c.end(); // loop — reached ONLY via the natural-fallthrough (found) exit
      c.localGet(STACK);
      c.localGet(PC_OUT);
      c.localGet(CPTR_OUT);
      c.localGet(BP);
      c.localGet(TOP); // newSp
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** backRefCompare(subject, cptr, capStart, capEnd, isUnicode,
   * isBackward, ignoreCase) -> (matches, newCptr) — the ENTIRE
   * character-comparison walk for REOP_back_reference(_i)/backward_
   * back_reference(_i) (libregexp.c:3184-3240's own forward/backward
   * while-loops), built as its OWN standalone function rather than
   * inlined into exec()'s dispatch loop — findings-p1-v1.txt's own
   * design-trace entry has the full reasoning: this is the first
   * opcode that would otherwise need a genuine loop NESTED inside a
   * case body with failIf/gotoNoMatch calls from WITHIN that loop, a
   * combination with no existing precedent in this file to verify a
   * hand-derived br-depth formula against. Sidestepping that risk
   * entirely (rather than deriving the formula carefully) by giving
   * the loop its own function, using the SAME free early-return
   * semantics noMatch/lookaheadMatch/newCaptureArray already
   * established — every exit here is `return_()`, which needs no
   * depth arithmetic regardless of block nesting, and the loop's own
   * CONTINUE is a single unconditional `br(0)` at the very end of the
   * loop body, once every other block opened that iteration has
   * already closed.
   *
   * isBackward/ignoreCase are RUNTIME i32 booleans (not TS-compile-
   * time — this ONE cached function serves all four REOP variants),
   * selecting which sub-operation the SAME loop body uses each
   * iteration via the linear default-then-override style rangeSearch's
   * own readPairAt already established for its is32 parameter: default
   * computations are forward-shaped (GET_CHAR-style, matching
   * REOP_back_reference), overridden to backward-shaped (GET_PREV_CHAR-
   * style, matching REOP_backward_back_reference) when isBackward
   * holds. GET_PREV_CHAR itself (libregexp.c:2680-2696) is exactly
   * peekPrevChar (compute the codepoint) + prevChar (compute the new
   * position) composed on the SAME starting cptr independently —
   * confirmed by reading both macro bodies side by side, not assumed
   * — so the backward override calls both already-proven primitives
   * rather than a fresh "get and move backward" one. */
  backRefCompare(): number {
    return this.cached("backRefCompare", () => {
      const SUBJECT = 0;
      const CPTR = 1;
      const CAP_START = 2;
      const CAP_END = 3;
      const IS_UNICODE = 4;
      const IS_BACKWARD = 5;
      const IGNORE_CASE = 6;
      const CPTR1 = 7;
      const C1 = 8;
      const C2 = 9;
      const NEW_CPTR1 = 10;
      const NEW_CPTR = 11;
      const STILL_MORE = 12;
      const EXHAUSTED = 13;
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRefType(), I32, I32, I32, I32, I32, I32], [I32, I32]),
        "%w.re.backRefCompare",
      );
      const c = new Code();
      // CPTR1 = isBackward ? capEnd : capStart
      c.localGet(CAP_START);
      c.localSet(CPTR1);
      c.localGet(IS_BACKWARD);
      c.ifVoid();
      c.localGet(CAP_END);
      c.localSet(CPTR1);
      c.end();

      c.loop();
      // still more to compare? default forward (cptr1 < capEnd), override backward (cptr1 > capStart)
      c.localGet(CPTR1);
      c.localGet(CAP_END);
      c.i32LtS();
      c.localSet(STILL_MORE);
      c.localGet(IS_BACKWARD);
      c.ifVoid();
      c.localGet(CPTR1);
      c.localGet(CAP_START);
      c.i32GtS();
      c.localSet(STILL_MORE);
      c.end();
      c.localGet(STILL_MORE);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(1);
      c.localGet(CPTR);
      c.return_();
      c.end();

      // subject exhausted? default forward (cptr>=subject.length), override backward (cptr==0)
      c.localGet(CPTR);
      c.localGet(SUBJECT);
      c.arrayLen();
      c.i32GeS();
      c.localSet(EXHAUSTED);
      c.localGet(IS_BACKWARD);
      c.ifVoid();
      c.localGet(CPTR);
      c.i32Eqz();
      c.localSet(EXHAUSTED);
      c.end();
      c.localGet(EXHAUSTED);
      c.ifVoid();
      c.i32Const(0);
      c.localGet(CPTR);
      c.return_();
      c.end();

      // read c1 (from the capture range) and c2 (from the subject),
      // advancing BOTH — GENUINE if/else, NOT the file's own usual
      // linear-default-then-override style: getChar (the "default"
      // forward read) is NOT safe to call unconditionally here, unlike
      // rangeSearch's own is32-driven width selection (which never
      // risks an out-of-bounds read either way). For the backward
      // direction, CPTR1/CPTR start at capEnd/(at-or-past the
      // subject's own length) — positions ONLY valid for a BACKWARD
      // read, not a forward one; calling getChar(subject, CPTR, ...)
      // "as the default, to be overridden after" on such a position
      // reads PAST the subject's own bounds and traps. Caught by this
      // primitive's own backward-direction pins on their FIRST run
      // (an actual out-of-bounds RuntimeError, not a wrong value) —
      // the SAME class of mistake the anchor family's own OOB-
      // avoidance design (line_start_m/word_boundary) already
      // exists specifically to prevent, just not applied here the
      // first time through.
      c.localGet(IS_BACKWARD);
      c.ifVoid();
      c.localGet(SUBJECT);
      c.localGet(CPTR1);
      c.localGet(IS_UNICODE);
      c.call(this.peekPrevChar());
      c.localSet(C1);
      c.localGet(SUBJECT);
      c.localGet(CPTR1);
      c.localGet(IS_UNICODE);
      c.call(this.prevChar());
      c.localSet(NEW_CPTR1);
      c.localGet(SUBJECT);
      c.localGet(CPTR);
      c.localGet(IS_UNICODE);
      c.call(this.peekPrevChar());
      c.localSet(C2);
      c.localGet(SUBJECT);
      c.localGet(CPTR);
      c.localGet(IS_UNICODE);
      c.call(this.prevChar());
      c.localSet(NEW_CPTR);
      c.else_();
      c.localGet(SUBJECT);
      c.localGet(CPTR1);
      c.localGet(IS_UNICODE);
      c.call(this.getChar());
      c.localSet(NEW_CPTR1);
      c.localSet(C1);
      c.localGet(SUBJECT);
      c.localGet(CPTR);
      c.localGet(IS_UNICODE);
      c.call(this.getChar());
      c.localSet(NEW_CPTR);
      c.localSet(C2);
      c.end();
      c.localGet(NEW_CPTR1);
      c.localSet(CPTR1);
      c.localGet(NEW_CPTR);
      c.localSet(CPTR);

      c.localGet(IGNORE_CASE);
      c.ifVoid();
      c.localGet(C1);
      c.call(this.regexCanonicalize());
      c.localSet(C1);
      c.localGet(C2);
      c.call(this.regexCanonicalize());
      c.localSet(C2);
      c.end();

      // mismatch? return fail. Otherwise fall through to the
      // unconditional br(0) below — the loop's own continue, reached
      // ONLY once every block opened this iteration has already closed.
      c.localGet(C1);
      c.localGet(C2);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(0);
      c.localGet(CPTR);
      c.return_();
      c.end();
      c.br(0);
      c.end(); // loop
      c.unreachable(); // every path above returns or continues; falling off is a bug

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** The br_table dispatch shape, hand-traced to this exact formula in
   * this file's own header comment BEFORE writing this function (the
   * F2-p3 lesson: never trust a `br` depth from memory). Emits, into
   * an ALREADY-OPEN `c` (this does NOT open its own function or its own
   * enclosing loop — the caller is expected to be inside a `loop` at
   * the point this is called, with nothing else open at that point):
   *   - opcodeCount+1 nested `block`s: default outermost, case[N-1]
   *     next, ..., case[0] innermost.
   *   - `selectorPush()` then a `brTable` with labels [0, 1, ..., N-1]
   *     and default label N (case[i]'s depth IS i by construction).
   *   - for k = 0..N-1, in order: `end()` (closes case[k]'s block,
   *     landing exactly where its body starts), the case's own body
   *     (from `cases.get(k)`, or `unreachableBody` if absent — an
   *     opcode this slice doesn't implement yet TRAPS rather than
   *     silently falling through to the default), then `br(N - k)` —
   *     the loop's own relative depth AT THAT POINT, per the header's
   *     hand-traced formula.
   *   - a final `end()` (closes the default block) then `defaultBody()`.
   * `opcodeCount` is the TOTAL number of dispatchable cases (0..
   * opcodeCount-1). Each case body receives its OWN continueLoopDepth
   * (= opcodeCount - k) as a PARAMETER — not just relied on implicitly
   * via the trailing `br` this function itself emits — so a case body
   * that wants to jump to "continue the dispatch loop" from a NESTED
   * position (e.g. a failure branch calling noMatch partway through its
   * own logic, not just at the very end) can reuse the SAME depth,
   * rather than every call site needing to re-derive or hand-count it.
   * testDispatchLoop's own case closures ignore this parameter (a
   * `() => void` closure is still assignable where `(d: number) =>
   * void` is expected — TS/JS both permit calling with an unused extra
   * argument) since that test predates split/no_match and never needs
   * an early "continue" from mid-body. */
  private emitSwitch(c: Code, selectorPush: () => void, opcodeCount: number, cases: Map<number, (continueLoopDepth: number) => void>, defaultBody: () => void): void {
    for (let i = 0; i <= opcodeCount; i++) c.block(); // opens: default(outermost,written first)...case[N-1]...case[0](innermost,written last)
    // Wait: blocks must be opened OUTERMOST FIRST in TEXT order, i.e.
    // the FIRST c.block() call becomes the OUTERMOST block. To get
    // default outermost and case[0] innermost, the FIRST call here
    // must correspond to default, and the LAST call to case[0] — which
    // is exactly the loop above (i=0 first -> default's block; i=
    // opcodeCount last -> case[0]'s block), so no further reordering is
    // needed; the loop already opens them in the right order.
    selectorPush();
    const labels: number[] = [];
    for (let i = 0; i < opcodeCount; i++) labels.push(i); // case[i]'s depth is i, by the trace above
    c.brTable(labels, opcodeCount);
    for (let k = 0; k < opcodeCount; k++) {
      c.end(); // closes case[k]'s block
      const body = cases.get(k);
      const continueLoopDepth = opcodeCount - k; // hand-traced in the header
      if (body) body(continueLoopDepth);
      else c.unreachable(); // this slice doesn't implement opcode k yet — trap, never guess
      // A case body that itself already exited (return_/br to somewhere
      // else) makes this br UNREACHABLE code, which is fine — wasm
      // permits unreachable code after an unconditional exit within a
      // block (the validator type-checks it in "polymorphic" mode).
      c.br(continueLoopDepth);
    }
    c.end(); // closes the default block
    defaultBody();
  }

  /** TEST-ONLY, exported so a pin can verify emitSwitch's mechanics in
   * isolation before exec() is built on top of it: reads a sequence of
   * "opcodes" from a tiny (array (mut i8)) — 0/1/2 mean "add 10/20/30
   * to an accumulator and continue"; anything else means "stop, return
   * the accumulator". Exercises exactly what exec()'s real dispatch
   * loop will need: multiple cases in one switch, each falling through
   * to a genuine loop CONTINUE (not a return) without leaking into a
   * neighboring case's body, plus a default/terminal case that exits
   * the loop by RETURNING instead of continuing. */
  testDispatchLoop(): number {
    return this.cached("testDispatchLoop", () => {
      const BC = 0;
      const POS = 1;
      const SUM = 2;
      const OP = 3;
      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType()], [I32]), "%w.re.testDispatchLoop");
      const c = new Code();
      c.i32Const(0);
      c.localSet(POS);
      c.i32Const(0);
      c.localSet(SUM);
      c.loop();
      c.localGet(BC);
      c.localGet(POS);
      c.arrayGetU(this.bcType);
      c.localSet(OP);
      c.localGet(POS);
      c.i32Const(1);
      c.i32Add();
      c.localSet(POS);
      this.emitSwitch(
        c,
        () => c.localGet(OP),
        3,
        new Map([
          [
            0,
            () => {
              c.localGet(SUM);
              c.i32Const(10);
              c.i32Add();
              c.localSet(SUM);
            },
          ],
          [
            1,
            () => {
              c.localGet(SUM);
              c.i32Const(20);
              c.i32Add();
              c.localSet(SUM);
            },
          ],
          [
            2,
            () => {
              c.localGet(SUM);
              c.i32Const(30);
              c.i32Add();
              c.localSet(SUM);
            },
          ],
        ]),
        () => {
          c.localGet(SUM);
          c.return_();
        },
      );
      c.end(); // loop
      c.localGet(SUM);
      this.mb.setBody(idx, [I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** regexCanonicalize(cp) -> i32 — the wasm-side port of regex-canon.
   * ts's own canonicalize() (§6.2's formula), for REOP_char_i/char32_i's
   * runtime half: libregexp.c:2949-2951 canonicalizes the CHARACTER
   * READ FROM THE SUBJECT at match time (a value only known once the
   * module runs) — the LITERAL operand embedded in the bytecode is
   * ALREADY canonicalized, at PARSE time, by regex-parser.ts's own
   * `st.ignoreCase ? canonicalize(c) : c` (matching the reference's own
   * compile-time `lre_canonicalize` call sites) — so exec() only ever
   * needs to canonicalize ONE side of the comparison, not both.
   *
   * Reuses casing.ts's caseConvCp(cp, convType), called here with
   * convType 0 — casing.ts's own convention for "upper", the ONLY
   * value this function ever passes — which returns (count, r0, r1,
   * r2); the SAME table-driven mapping String.prototype.toUpperCase()
   * itself compiles to (casing.ts's own header) — rather than porting a
   * fresh table: this is a REUSE of an already-measured primitive, not
   * a new one. Per
   * regex-canon.ts's own formula, transcribed directly (linear default-
   * then-conditionally-override, this file's own standing style):
   *   count !== 1            -> cp (identity; multi-codepoint mappings,
   *                              e.g. sharp-s, are excluded exactly like
   *                              regex-canon.ts's `chars.length !== 1`)
   *   cp >= 128 && r0 < 128  -> cp (regex-canon.ts's own ASCII-boundary
   *                              guard — default already covers this)
   *   else                   -> r0
   *
   * No isUnicode parameter, matching regex-canon.ts's own signature
   * exactly: §6.3(a)'s FENCED scope guard means /iu never reaches
   * character compilation at all (unicode-mode /i needs simple case
   * FOLDING, a genuinely different algorithm this port refuses, not a
   * variant of this one) — so exec() never calls this under isUnicode,
   * and this function has no way to be asked to. */
  regexCanonicalize(): number {
    return this.cached("regexCanonicalize", () => {
      const CP = 0;
      const COUNT = 1;
      const R0 = 2;
      const R1 = 3;
      const R2 = 4;
      const RESULT = 5;
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.re.canonicalize");
      const c = new Code();
      c.localGet(CP);
      c.i32Const(0); // convType 0 = upper
      c.call(this.casing.caseConvCp());
      c.localSet(R2);
      c.localSet(R1);
      c.localSet(R0);
      c.localSet(COUNT);
      // default: identity
      c.localGet(CP);
      c.localSet(RESULT);
      c.localGet(COUNT);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      // NOT(cp>=128 && r0<128) -> override with r0
      c.localGet(CP);
      c.i32Const(128);
      c.i32GeS();
      c.localGet(R0);
      c.i32Const(128);
      c.i32LtS();
      c.i32And();
      c.i32Eqz();
      c.ifVoid();
      c.localGet(R0);
      c.localSet(RESULT);
      c.end();
      c.end();
      c.localGet(RESULT);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** rangeSearch(table, pos, n, is32, c) -> i32 (0/1) — the SHARED
   * binary-search-over-sorted-ranges core behind REOP_range/range32
   * (libregexp.c:3241-3319) AND REOP_space/not_space's fixed \s/\S
   * tables (buildFixedRangeTable's own doc comment): ONE function,
   * `is32` a RUNTIME boolean choosing between 4-byte (u16,u16) and
   * 8-byte (u32,u32) pair widths, rather than two near-duplicate
   * functions — a wasm function can't take a function VALUE as a
   * parameter to share code that way, but it CAN take a plain i32 and
   * branch on it internally (this file's own linear default-then-
   * override style, applied to CODE SELECTION rather than a single
   * result value this time: readPairAt's default reads ARE the 16-bit
   * form, its ifVoid override REDOES both reads as 32-bit — the second
   * read simply overwrites the first's result, no wasted branch-around
   * needed since both are cheap array reads, not side-effecting).
   * `table`/`pos` let the SAME search run against either the per-
   * pattern bytecode array at a computed offset (REOP_range/range32)
   * or a dedicated fixed table array at offset 0 (REOP_space/
   * not_space) — both share bcType (array i8), so no second array type
   * or second pair of reader functions is needed either.
   *
   * Transcribed 1:1 from the C reference, INCLUDING its two early-exit
   * checks before the O(log n) loop even starts (checking against
   * pair[0]'s low and pair[n-1]'s high) — these are a pure C
   * optimization with no semantic content EXCEPT for one thing that
   * makes them non-optional here too: the 16-bit form's own "0xffff in
   * the last pair's high position means +infinity" convention (an
   * ASTRAL codepoint can't be represented as a literal u16 upper bound,
   * so a range that should extend past 0xFFFF encodes that as the
   * sentinel instead) can ONLY be checked once pair[n-1]'s high is
   * already in hand — dropping the early check would mean re-deriving
   * where in the loop to test it instead, not simplifying anything.
   * This special case is is32-CONDITIONAL (`!is32`): the 32-bit form's
   * high field can represent the genuine upper bound directly (up to
   * 0x10FFFF), so it never needs a sentinel and the reference's own
   * REOP_range32 case has no equivalent check — confirmed by reading
   * both C case blocks side by side, not assumed symmetric. */
  rangeSearch(): number {
    return this.cached("rangeSearch", () => {
      const TABLE = 0;
      const POS = 1;
      const N = 2;
      const IS32 = 3;
      const CH = 4;
      const ELEM_SIZE = 5;
      const IDX = 6;
      const LOW = 7;
      const HIGH = 8;
      const OFF = 9;
      const IDX_MIN = 10;
      const IDX_MAX = 11;
      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType(), I32, I32, I32, I32], [I32]), "%w.re.rangeSearch");
      const c = new Code();

      // elemSize = is32 ? 8 : 4 (bytes per (low,high) pair)
      c.i32Const(4);
      c.localSet(ELEM_SIZE);
      c.localGet(IS32);
      c.ifVoid();
      c.i32Const(8);
      c.localSet(ELEM_SIZE);
      c.end();

      // readPairAt(): OFF = pos + idx*elemSize; LOW/HIGH from IDX's
      // current value — default 16-bit reads, is32 overrides both.
      const readPairAt = (): void => {
        c.localGet(POS);
        c.localGet(IDX);
        c.localGet(ELEM_SIZE);
        c.i32Mul();
        c.i32Add();
        c.localSet(OFF);
        c.localGet(TABLE);
        c.localGet(OFF);
        c.call(this.readU16());
        c.localSet(LOW);
        c.localGet(TABLE);
        c.localGet(OFF);
        c.i32Const(2);
        c.i32Add();
        c.call(this.readU16());
        c.localSet(HIGH);
        c.localGet(IS32);
        c.ifVoid();
        c.localGet(TABLE);
        c.localGet(OFF);
        c.call(this.readU32());
        c.localSet(LOW);
        c.localGet(TABLE);
        c.localGet(OFF);
        c.i32Const(4);
        c.i32Add();
        c.call(this.readU32());
        c.localSet(HIGH);
        c.end();
      };

      // if (c < low[0]) return 0; UNSIGNED: an is32 table's own bound
      // values can exceed 0x7fffffff (caseCloseClass's astral-tail
      // preservation runs up to the 0xffffffff sentinel, emitRange
      // writes that sentinel's own high-1=0xfffffffe verbatim), which
      // reads back as NEGATIVE under a signed comparison.
      c.i32Const(0);
      c.localSet(IDX);
      readPairAt();
      c.localGet(CH);
      c.localGet(LOW);
      c.i32LtU();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();

      // idxMax = n - 1; read pair[n-1] to get high[n-1].
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(IDX_MAX);
      c.localGet(IDX_MAX);
      c.localSet(IDX);
      readPairAt();

      // 16-bit-only infinity sentinel: c>=0xffff && high[n-1]==0xffff -> match.
      c.localGet(IS32);
      c.i32Eqz();
      c.localGet(CH);
      c.i32Const(0xffff);
      c.i32GeS();
      c.i32And();
      c.localGet(HIGH);
      c.i32Const(0xffff);
      c.i32Eq();
      c.i32And();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();

      // if (c > high[n-1]) return 0; UNSIGNED — see the c<low[0] check's
      // own comment above; the same overflow-into-negative risk applies
      // to every CH-vs-HIGH/LOW comparison in this function.
      c.localGet(CH);
      c.localGet(HIGH);
      c.i32GtU();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();

      // while (idxMin <= idxMax) { idx = (idxMin+idxMax)/2; ... }
      c.i32Const(0);
      c.localSet(IDX_MIN);
      c.loop();
      c.localGet(IDX_MIN);
      c.localGet(IDX_MAX);
      c.i32GtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(IDX_MIN);
      c.localGet(IDX_MAX);
      c.i32Add();
      c.i32Const(2);
      c.i32DivS();
      c.localSet(IDX);
      readPairAt();
      // UNSIGNED — same CH-vs-LOW/HIGH overflow risk as the two
      // early-exit checks above.
      c.localGet(CH);
      c.localGet(LOW);
      c.i32LtU();
      c.ifVoid();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(IDX_MAX);
      c.br(1); // continue the search loop
      c.end();
      c.localGet(CH);
      c.localGet(HIGH);
      c.i32GtU();
      c.ifVoid();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localSet(IDX_MIN);
      c.br(1); // continue the search loop
      c.end();
      c.i32Const(1);
      c.return_();
      c.end(); // loop
      c.unreachable(); // every path above returns or continues — see this file's own "falling off is a bug" convention

      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** exec(bytecode, subject, startIndex, captureOut) -> i32 — design
   * §2.1's own signature, this file's central deliverable. THIS SLICE
   * covers REOP_char, REOP_char32, REOP_char_i, REOP_char32_i (the
   * ignore-case pair reuses regexCanonicalize() — see its own doc
   * comment for why only the subject-read character, never the
   * bytecode operand, needs a RUNTIME canonicalize call), REOP_dot, REOP_any,
   * REOP_save_start, REOP_save_end, REOP_save_reset (needed for
   * QUANTIFIED capturing groups like `(a)*` — the assembler already
   * emits it, this slice just interprets it; see emitSaveReset's own
   * doc comment), REOP_split_goto_first, REOP_split_
   * next_first, REOP_goto, REOP_prev, REOP_range/range32/range_i/
   * range32_i (rangeSearch()'s own doc comment), REOP_space/not_space
   * (the SAME rangeSearch() against a FIXED, embedded \s/\S table —
   * buildFixedRangeTable's own doc comment), REOP_line_start(_m)/
   * line_end(_m) and REOP_word_boundary(_i)/not_word_boundary(_i)
   * (emitLineStart/emitLineEnd/emitWordBoundary's own doc comments —
   * a fail flag is computed into a flat scratch local FIRST, safely,
   * THEN one failIf consumes it at the outer level, so the short-
   * circuit those opcodes need never requires gotoNoMatch itself to
   * sit any deeper than failIf's own proven "+1"), REOP_set_i32/loop/
   * loop_split_{goto,next}_first/loop_check_adv_split_{goto,next}_
   * first/set_char_pos/check_advance (the REGISTER family — bounded-
   * count quantifiers like `a{3}`; saveCaptureCheck()/computeRegIdx/
   * saveRegister's own doc comments — registers live PAST the real
   * capture slots in the SAME captureOut array, captureOut's own
   * sizing to fit them is the CALLER's responsibility), REOP_lookahead/
   * negative_lookahead (emitLookaheadPush's own doc comment — pushes a
   * marker, never redirects pc), REOP_lookahead_match (lookaheadMatch()
   * — a DELIBERATE re-derivation of the reference's own packed-pointer
   * compaction trick, not a transcription of it; see that function's
   * own doc comment and findings-p1-v1.txt's own design-trace entry for
   * the hand-traced equivalence proof and the CONTRACT it preserves),
   * REOP_negative_lookahead_match (unwindToType(NEGATIVE_LOOKAHEAD) +
   * the STANDARD gotoNoMatch — TWO calls to the SAME parameterized
   * noMatch, mirroring the reference's own "separate loop, then goto
   * no_match" structure; see noMatch's own doc comment for the full
   * history of this decision), REOP_back_reference/back_reference_i/
   * backward_back_reference/backward_back_reference_i (backRefCompare()
   * — its own standalone character-comparison walk, plus a structural
   * search loop finding the first SET candidate among n possible
   * capture-group indices, needed for ES2025's duplicate named capture
   * groups; see backRefCompare's own doc comment and findings-p1-
   * v1.txt's own design-trace entry), and REOP_match. `no_match`
   * (libregexp.c:2862-2883) is the FULL general form (this.noMatch(),
   * oracle-proven against synthetic stacks BEFORE being wired in here —
   * see its own doc comment) — real backtracking works. Every other
   * opcode TRAPS (emitSwitch's own default-to-unreachable for a case
   * absent from the map) rather than silently doing nothing. This is
   * the FULL opcode set this port's own interpreter implements — the
   * last opcode family (back_reference) closed with this pass. */
  exec(): number {
    return this.cached("exec", () => {
      const BYTECODE = 0;
      const SUBJECT = 1;
      const START_INDEX = 2;
      const CAPTURE_OUT = 3;
      const PC = 4;
      const CPTR = 5;
      const SP = 6;
      const BP = 7;
      const STACK = 8;
      const IS_UNICODE = 9;
      const OPCODE = 10;
      const VAL = 11;
      const C_CHAR = 12;
      const NEW_CPTR = 13;
      const IDX = 14;
      const PC1 = 15;
      const SHOULD_RETURN0 = 16;
      const RESET_END = 17;
      const N = 18;
      const TABLE_POS = 19;
      const MATCHED = 20;
      const SPACE_TABLE = 21;
      const NOT_SPACE_TABLE = 22;
      const V1 = 23;
      const V2 = 24;
      const CAPTURE_COUNT = 25;
      const REG = 26;
      const LIMIT = 27;
      const NEW_COUNTER = 28;
      const I = 29;
      const CAP_START = 30;
      const CAP_END = 31;
      const S0 = 32;
      const S1 = 33;

      const idx = this.mb.declareFunc(this.mb.funcType([this.bcRefType(), this.strRefType(), I32, this.capRefType()], [I32]), "%w.re.exec");
      const c = new Code();

      // Setup (lre_exec, libregexp.c:3346-3363, minus the capture[]=NULL
      // loop — that's the CALLER's job now: newCaptureArray() already
      // fills with -1, and captureOut is caller-owned).
      c.localGet(BYTECODE);
      c.i32Const(RE_HEADER_FLAGS);
      c.call(this.readU16());
      c.i32Const(LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS);
      c.i32And();
      c.i32Const(0);
      c.i32Ne();
      c.localSet(IS_UNICODE);

      // s->capture_count (libregexp.c:3348) — a NEW setup read this
      // slice needed: every earlier capture-touching opcode (save_
      // start/end/reset) takes the capture INDEX directly as its own
      // operand, never needing capture_count itself. The register
      // family below does: register N lives at captureOut[2*capture_
      // count + N] (past the real capture slots) — captureOut's own
      // SIZING to fit that is the CALLER's responsibility, same as
      // ever; exec() only reads capture_count to compute the offset.
      c.localGet(BYTECODE);
      c.i32Const(RE_HEADER_CAPTURE_COUNT);
      c.call(this.readU8());
      c.localSet(CAPTURE_COUNT);

      c.i32Const(RE_HEADER_LEN);
      c.localSet(PC);
      c.localGet(START_INDEX);
      c.localSet(CPTR);
      c.i32Const(0);
      c.localSet(SP);
      c.i32Const(0);
      c.localSet(BP);
      // Initial backtrack-stack size matches C's static_stack_buf[32].
      c.i32Const(32);
      c.arrayNewDefault(this.capType);
      c.localSet(STACK);

      // REOP_space/not_space's fixed \s/\S tables (buildFixedRangeTable's
      // own doc comment): materialized fresh EVERY call, unconditionally,
      // the SAME "just allocate it, it's cheap" choice STACK above
      // already makes — these tables are at most a few dozen bytes, and
      // a lazy-global guard (casing.ts's OWN pattern, for its genuinely
      // large shared tables) would add real complexity here to save an
      // allocation this small.
      c.i32Const(this.spaceTable.offset);
      c.i32Const(this.spaceTable.length);
      c.arrayNewData(this.bcType, 0);
      c.localSet(SPACE_TABLE);
      c.i32Const(this.notSpaceTable.offset);
      c.i32Const(this.notSpaceTable.length);
      c.arrayNewData(this.bcType, 0);
      c.localSet(NOT_SPACE_TABLE);

      // unwindToType(stopType): calls this.noMatch() with the given
      // compareType/continueOnEqual, unpacks its results into PC/CPTR/
      // BP/SP, and returns 0 immediately if shouldReturn0 fired —
      // WITHOUT branching anywhere afterward. The shared piece BOTH
      // gotoNoMatch (compareType=LOOKAHEAD, continueOnEqual=true: skip
      // past LOOKAHEAD markers, stop on everything else — then branches
      // to continue dispatch) and emitNegativeLookaheadMatch
      // (compareType=NEGATIVE_LOOKAHEAD, continueOnEqual=FALSE: skip
      // past EVERYTHING except its own marker, stop there specifically
      // — the OPPOSITE polarity, see noMatch's own doc comment for why
      // — then falls through into a SECOND call, this time via
      // gotoNoMatch itself, exactly mirroring the reference's own
      // "separate loop, then goto no_match" structure, libregexp.c:
      // 2917-2935) need.
      const unwindToType = (compareType: number, continueOnEqual: boolean): void => {
        c.localGet(STACK);
        c.localGet(SP);
        c.localGet(BP);
        c.localGet(CAPTURE_OUT);
        c.i32Const(compareType);
        c.i32Const(continueOnEqual ? 1 : 0);
        c.call(this.noMatch());
        // Results declared [shouldReturn0, newPc, newCptr, newBp, newSp]
        // — popped in REVERSE declaration order (this file's own
        // established convention, e.g. getChar's doc comment).
        c.localSet(SP);
        c.localSet(BP);
        c.localSet(CPTR);
        c.localSet(PC);
        c.localSet(SHOULD_RETURN0);
        c.localGet(SHOULD_RETURN0);
        c.ifVoid();
        c.i32Const(0);
        c.return_();
        c.end();
      };

      // gotoNoMatch: libregexp.c:2862-2883's generic backtrack-pop loop,
      // via unwindToType(LOOKAHEAD) — independently oracle-proven, see
      // noMatch's own doc comment. `continueLoopDepth` is the SAME depth
      // emitSwitch computes for THIS case's own trailing "continue the
      // dispatch loop" br — passed through from the case body's own
      // parameter so a failure branch reachable from mid-case (not just
      // its very end) can jump to the identical target. NOT called
      // directly by opcode handlers — see failIf below, which is: this
      // bug's own origin was calling gotoNoMatch's `br` from ONE level
      // DEEPER than continueLoopDepth accounts for (nested inside the
      // handler's OWN `ifVoid` condition check), a real off-by-one that
      // validated cleanly and only surfaced as a runtime "unreachable"
      // trap — exactly the F2-p3 risk class (a wrong depth is not a
      // validator error). failIf owns the +1 internally so no future
      // opcode handler has to re-derive it by hand.
      const gotoNoMatch = (continueLoopDepth: number): void => {
        unwindToType(RE_EXEC_STATE_LOOKAHEAD, true);
        c.br(continueLoopDepth); // pc/cptr/bp/sp already point at the restored retry target
      };

      // failIf(pushCondition, continueLoopDepth): pushCondition() must
      // leave an i32 boolean on the stack; if true, goes to no_match.
      // Wraps pushCondition+ifVoid+gotoNoMatch+end as ONE unit so the
      // "+1 nesting level" gotoNoMatch's own `br` needs (it executes
      // INSIDE the ifVoid THIS function opens) is computed HERE, once,
      // rather than left for every call site to get right by hand.
      const failIf = (pushCondition: () => void, continueLoopDepth: number): void => {
        pushCondition();
        c.ifVoid();
        gotoNoMatch(continueLoopDepth + 1);
        c.end();
      };

      // ignoreCase (REOP_char_i/char32_i, libregexp.c:2949-2951):
      // canonicalizes the character READ FROM THE SUBJECT before the
      // comparison — `val` (the bytecode operand) is ALREADY
      // canonicalized, at PARSE time, by regex-parser.ts's own
      // `st.ignoreCase ? canonicalize(c) : c` (see regexCanonicalize's
      // own doc comment). No isUnicode branch here: §6.3(a)'s fenced
      // scope guard means an ignoreCase char node is never produced
      // under /iu, so this port's assembler never emits char_i/
      // char32_i for a unicode-mode pattern in the first place.
      const emitTestChar = (is32: boolean, ignoreCase: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          if (is32) {
            c.localGet(BYTECODE);
            c.localGet(PC);
            c.call(this.readU32());
            c.localSet(VAL);
            c.localGet(PC);
            c.i32Const(4);
            c.i32Add();
            c.localSet(PC);
          } else {
            c.localGet(BYTECODE);
            c.localGet(PC);
            c.call(this.readU16());
            c.localSet(VAL);
            c.localGet(PC);
            c.i32Const(2);
            c.i32Add();
            c.localSet(PC);
          }
          // if (cptr >= subject.length) goto no_match;
          failIf(() => {
            c.localGet(CPTR);
            c.localGet(SUBJECT);
            c.arrayLen();
            c.i32GeS();
          }, continueLoopDepth);
          // GET_CHAR(c, cptr, ...): advances cptr, combines a surrogate
          // pair under isUnicode (getChar's own doc/tests).
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.getChar());
          c.localSet(NEW_CPTR);
          c.localSet(C_CHAR);
          c.localGet(NEW_CPTR);
          c.localSet(CPTR);
          if (ignoreCase) {
            c.localGet(C_CHAR);
            c.call(this.regexCanonicalize());
            c.localSet(C_CHAR);
          }
          // if (val != c) goto no_match;
          failIf(() => {
            c.localGet(VAL);
            c.localGet(C_CHAR);
            c.i32Ne();
          }, continueLoopDepth);
        };
      };

      const emitSaveCapture = (offsetBit: 0 | 1): (() => void) => {
        return () => {
          // val = *pc++ (the capture-slot NUMBER, not yet the array idx)
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU8());
          c.localSet(VAL);
          c.localGet(PC);
          c.i32Const(1);
          c.i32Add();
          c.localSet(PC);
          // idx = 2*val + offsetBit (libregexp.c:3046's own formula;
          // the bytecode-error bounds check on `val` is skipped — this
          // port's OWN assembler is the only bytecode source and is
          // already byte-identical-verified, so a malformed index here
          // would be an assembler bug, not a reachable runtime input;
          // an out-of-range idx traps naturally via array OOB instead
          // of this port replicating C's numeric LRE_RET_BYTECODE_ERROR
          // convention).
          c.localGet(VAL);
          c.i32Const(2);
          c.i32Mul();
          if (offsetBit) {
            c.i32Const(1);
            c.i32Add();
          }
          c.localSet(IDX);
          // SAVE_CAPTURE(idx, cptr): ensure room, push (idx, OLD value),
          // then write the new value.
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(2);
          c.call(this.ensureStackSpace());
          c.localSet(STACK);
          c.localGet(STACK);
          c.localGet(SP);
          c.localGet(IDX);
          c.arraySet(this.capType);
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(1);
          c.i32Add();
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.arrayGet(this.capType);
          c.arraySet(this.capType);
          c.localGet(SP);
          c.i32Const(2);
          c.i32Add();
          c.localSet(SP);
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.localGet(CPTR);
          c.arraySet(this.capType);
        };
      };

      // REOP_save_reset (libregexp.c:3049-3066): resets BOTH capture
      // slots (start and end) of EVERY capture index in [val, val2]
      // (inclusive, TWO SEPARATE u8 bytecode operands — not one count)
      // back to "unset" (this port's -1 sentinel for C's NULL, see
      // this file's own header, translation 2). Each slot write goes
      // through the SAME undo-stack push emitSaveCapture uses (its OWN
      // (idx, oldValue) 2-slot SAVE_CAPTURE pattern, called separately
      // per slot — matching libregexp.c's own two distinct SAVE_CAPTURE
      // calls per loop iteration, not merged into one bigger push),
      // which is why noMatch's existing generic 2-slot-pop undo loop
      // restores a reset exactly like any other capture write with no
      // special-casing needed there. Only reachable once QUANTIFIED
      // capturing groups compile (`(a)*`, where a later loop iteration
      // must not see a STALE capture from an earlier iteration that
      // didn't run this time) — the assembler already emits it
      // (last_capture_count bookkeeping, regex-assembler.ts); exec()
      // just has to interpret it. `val`/`val2`'s own bytecode-error
      // bounds check (libregexp.c:3055-3056) is skipped for the same
      // reason emitSaveCapture skips its own: this port's assembler is
      // the ONLY bytecode source and is already byte-verified, so an
      // out-of-range idx here would be an assembler bug, not a
      // reachable runtime input — it traps naturally via array OOB.
      const emitSaveReset = (): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(VAL);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.localSet(PC);
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(RESET_END);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.localSet(PC);
        const pushReset = (): void => {
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(2);
          c.call(this.ensureStackSpace());
          c.localSet(STACK);
          c.localGet(STACK);
          c.localGet(SP);
          c.localGet(IDX);
          c.arraySet(this.capType);
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(1);
          c.i32Add();
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.arrayGet(this.capType);
          c.arraySet(this.capType);
          c.localGet(SP);
          c.i32Const(2);
          c.i32Add();
          c.localSet(SP);
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.i32Const(-1);
          c.arraySet(this.capType);
        };
        // while (val <= val2) { pushReset(2*val); pushReset(2*val+1); val++; }
        // — same "continue while true, fall through to exit" idiom as
        // noMatch's own undo loop (this file's established style, not
        // a fresh invention here).
        c.loop();
        c.localGet(VAL);
        c.localGet(RESET_END);
        c.i32LeS();
        c.ifVoid();
        c.localGet(VAL);
        c.i32Const(2);
        c.i32Mul();
        c.localSet(IDX);
        pushReset();
        c.localGet(IDX);
        c.i32Const(1);
        c.i32Add();
        c.localSet(IDX);
        pushReset();
        c.localGet(VAL);
        c.i32Const(1);
        c.i32Add();
        c.localSet(VAL);
        c.br(1); // continue the reset loop
        c.end();
        c.end(); // reset loop closes, exiting when val > val2
      };

      // REOP_split_goto_first / REOP_split_next_first (libregexp.c:
      // 2955-2976): read a relative offset, choose which branch runs
      // immediately (pc) vs which becomes the backtrack target (pc1)
      // per isNextFirst, push a 4-slot backtrack-point entry (pc1,
      // cptr, bp, SPLIT — this port's unpacked equivalent of C's 3-slot
      // {ptr,ptr,bp-bitfield}, see this file's own header), then
      // bp = sp (the new backtrack base).
      // pushSplitEntry(isNextFirst): given VAL already holding the
      // relative offset and PC already pointing PAST that offset's own
      // operand bytes, computes pc1 (backtrack target) vs pc (runs
      // immediately) per isNextFirst, then pushes the 4-slot backtrack-
      // point entry (pc1, cptr, bp, SPLIT) and sets bp=sp — the shared
      // tail BOTH emitSplit (plain REOP_split_*, its own 4-byte operand
      // read immediately before this) and emitLoopSplit (the register
      // family's own conditional split, VAL populated from a DIFFERENT
      // multi-field operand layout) reuse, rather than duplicating this
      // push logic a second time.
      const pushSplitEntry = (isNextFirst: boolean): void => {
        if (isNextFirst) {
          // pc1 (backtrack target) = pc + val; pc (runs immediately) stays put.
          c.localGet(PC);
          c.localGet(VAL);
          c.i32Add();
          c.localSet(PC1);
        } else {
          // pc1 (backtrack target) = pc (unchanged); pc (runs immediately) = pc + val.
          c.localGet(PC);
          c.localSet(PC1);
          c.localGet(PC);
          c.localGet(VAL);
          c.i32Add();
          c.localSet(PC);
        }
        c.localGet(STACK);
        c.localGet(SP);
        c.i32Const(4);
        c.call(this.ensureStackSpace());
        c.localSet(STACK);
        c.localGet(STACK);
        c.localGet(SP);
        c.localGet(PC1);
        c.arraySet(this.capType);
        c.localGet(STACK);
        c.localGet(SP);
        c.i32Const(1);
        c.i32Add();
        c.localGet(CPTR);
        c.arraySet(this.capType);
        c.localGet(STACK);
        c.localGet(SP);
        c.i32Const(2);
        c.i32Add();
        c.localGet(BP);
        c.arraySet(this.capType);
        c.localGet(STACK);
        c.localGet(SP);
        c.i32Const(3);
        c.i32Add();
        c.i32Const(RE_EXEC_STATE_SPLIT);
        c.arraySet(this.capType);
        c.localGet(SP);
        c.i32Const(4);
        c.i32Add();
        c.localSet(SP);
        c.localGet(SP);
        c.localSet(BP);
      };

      const emitSplit = (isNextFirst: boolean): (() => void) => {
        return () => {
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU32());
          c.localSet(VAL);
          c.localGet(PC);
          c.i32Const(4);
          c.i32Add();
          c.localSet(PC); // pc now points PAST the 4-byte relative-offset operand
          pushSplitEntry(isNextFirst);
        };
      };

      // REOP_goto (libregexp.c:2989-2994, minus the timeout poll — see
      // noMatch's own doc comment on why that's not ported): an
      // unconditional relative jump.
      const emitGoto = (): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU32());
        c.localSet(VAL);
        c.localGet(PC);
        c.i32Const(4);
        c.i32Add();
        c.localGet(VAL);
        c.i32Add();
        c.localSet(PC);
      };

      // isLineTerminator(cLocal): pushes an i32 boolean — libregexp.c:
      // 2626-2629's `c == '\n' || c == '\r' || c == CP_LS || c == CP_PS`.
      const emitIsLineTerminator = (cLocal: number): void => {
        c.localGet(cLocal);
        c.i32Const(0x0a);
        c.i32Eq();
        c.localGet(cLocal);
        c.i32Const(0x0d);
        c.i32Eq();
        c.i32Or();
        c.localGet(cLocal);
        c.i32Const(0x2028);
        c.i32Eq();
        c.i32Or();
        c.localGet(cLocal);
        c.i32Const(0x2029);
        c.i32Eq();
        c.i32Or();
      };

      // REOP_dot / REOP_any (libregexp.c:3015-3026): both GET_CHAR one
      // character (failing if none is available); dot additionally
      // fails when that character is a line terminator, any accepts
      // anything. No bytecode operand for either (REOP_SIZE=1).
      const emitDotOrAny = (isAny: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          failIf(() => {
            c.localGet(CPTR);
            c.localGet(SUBJECT);
            c.arrayLen();
            c.i32GeS();
          }, continueLoopDepth);
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.getChar());
          c.localSet(NEW_CPTR);
          c.localSet(C_CHAR);
          c.localGet(NEW_CPTR);
          c.localSet(CPTR);
          if (!isAny) {
            failIf(() => emitIsLineTerminator(C_CHAR), continueLoopDepth);
          }
        };
      };

      // REOP_prev (libregexp.c:3320-3325): "go to the previous char" —
      // fails at the very start of the subject (cptr == 0, this port's
      // index-based equivalent of `cptr == s->cbuf`); otherwise steps
      // cptr backward by one character via prevChar (independently
      // tested — combines a surrogate pair backward under isUnicode).
      const emitPrev = (continueLoopDepth: number): void => {
        failIf(() => {
          c.localGet(CPTR);
          c.i32Eqz();
        }, continueLoopDepth);
        c.localGet(SUBJECT);
        c.localGet(CPTR);
        c.localGet(IS_UNICODE);
        c.call(this.prevChar());
        c.localSet(CPTR);
      };

      // REOP_range/range32(_i) (libregexp.c:3241-3319): n = read u16
      // (ALWAYS u16, regardless of is32 — confirmed reading BOTH C case
      // blocks, not assumed symmetric), the range TABLE itself follows
      // immediately in the bytecode at the now-current pc. GET_CHAR,
      // canonicalize if ignoreCase, then rangeSearch() does the actual
      // membership test (its own doc comment). pc only advances PAST
      // the table on a MATCH — matching the reference's own structure
      // (pc += 4*n/8*n sits AFTER the `goto no_match`s, at the
      // range_match: label) — a failure branches away via failIf before
      // ever reaching that advance, so leaving pc stale there is fine
      // (noMatch's own restore overwrites it on backtrack).
      const emitRangeTest = (is32: boolean, ignoreCase: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU16());
          c.localSet(N);
          c.localGet(PC);
          c.i32Const(2);
          c.i32Add();
          c.localSet(PC);
          c.localGet(PC);
          c.localSet(TABLE_POS);
          failIf(() => {
            c.localGet(CPTR);
            c.localGet(SUBJECT);
            c.arrayLen();
            c.i32GeS();
          }, continueLoopDepth);
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.getChar());
          c.localSet(NEW_CPTR);
          c.localSet(C_CHAR);
          c.localGet(NEW_CPTR);
          c.localSet(CPTR);
          if (ignoreCase) {
            c.localGet(C_CHAR);
            c.call(this.regexCanonicalize());
            c.localSet(C_CHAR);
          }
          c.localGet(BYTECODE);
          c.localGet(TABLE_POS);
          c.localGet(N);
          c.i32Const(is32 ? 1 : 0);
          c.localGet(C_CHAR);
          c.call(this.rangeSearch());
          c.localSet(MATCHED);
          failIf(() => {
            c.localGet(MATCHED);
            c.i32Eqz();
          }, continueLoopDepth);
          c.localGet(TABLE_POS);
          c.localGet(N);
          c.i32Const(is32 ? 8 : 4);
          c.i32Mul();
          c.i32Add();
          c.localSet(PC);
        };
      };

      // REOP_space/REOP_not_space (libregexp.c:3027-3040): NO bytecode
      // operand (unlike range/range32) — GET_CHAR, then rangeSearch()
      // against a FIXED table materialized once at the top of this
      // function (SPACE_TABLE/NOT_SPACE_TABLE), never against anything
      // read from the bytecode array itself. NOT_SPACE_TABLE is \S's
      // OWN CharRange (crInvert of \s, buildFixedRangeTable's own
      // construction in the constructor) — NOT the \s table queried
      // with an inverted check. Because of that, `matched` ALREADY
      // means "c belongs to THIS opcode's own target set" for BOTH
      // opcodes (space: c is whitespace; not_space: c is NOT
      // whitespace) — so the fail condition is IDENTICAL for both:
      // fail iff !matched. (A first draft of this function queried the
      // correct per-opcode table but then ALSO conditionally skipped
      // the Eqz for not_space, as if it were still checking the SPACE
      // table with inverted polarity — two inversions stacked, which
      // canceled out wrong: /\S/ matched exactly backwards. Caught by
      // the CASES pins immediately below, both directions failing in
      // the exact inverted shape, not by inspection.)
      const emitSpaceTest = (isNotSpace: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          failIf(() => {
            c.localGet(CPTR);
            c.localGet(SUBJECT);
            c.arrayLen();
            c.i32GeS();
          }, continueLoopDepth);
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.getChar());
          c.localSet(NEW_CPTR);
          c.localSet(C_CHAR);
          c.localGet(NEW_CPTR);
          c.localSet(CPTR);
          const table = isNotSpace ? this.notSpaceTable : this.spaceTable;
          c.localGet(isNotSpace ? NOT_SPACE_TABLE : SPACE_TABLE);
          c.i32Const(0); // pos: these are their OWN dedicated arrays, not a slice of BYTECODE
          c.i32Const(table.n);
          c.i32Const(table.is32 ? 1 : 0);
          c.localGet(C_CHAR);
          c.call(this.rangeSearch());
          c.localSet(MATCHED);
          failIf(() => {
            c.localGet(MATCHED);
            c.i32Eqz(); // fail iff c is NOT in this opcode's own target set
          }, continueLoopDepth);
        };
      };

      // isWordByte(cLocal): libunicode.c:568-608's lre_ctype_bits[256]
      // table, verified ROW BY ROW (not assumed from the macro names)
      // to have NO U/L/D/_ bit set anywhere above 127 — so for c<256
      // "word byte" is exactly the plain ASCII test [A-Za-z0-9_], not
      // a 256-entry table port. A flat i32-op chain is SAFE here (no
      // memory access, cLocal is already a resolved value), matching
      // emitIsLineTerminator's own flat-OR-of-comparisons shape.
      const emitIsWordByte = (cLocal: number): void => {
        c.localGet(cLocal);
        c.i32Const(0x41);
        c.i32GeS();
        c.localGet(cLocal);
        c.i32Const(0x5a);
        c.i32LeS();
        c.i32And();
        c.localGet(cLocal);
        c.i32Const(0x61);
        c.i32GeS();
        c.localGet(cLocal);
        c.i32Const(0x7a);
        c.i32LeS();
        c.i32And();
        c.i32Or();
        c.localGet(cLocal);
        c.i32Const(0x30);
        c.i32GeS();
        c.localGet(cLocal);
        c.i32Const(0x39);
        c.i32LeS();
        c.i32And();
        c.i32Or();
        c.localGet(cLocal);
        c.i32Const(0x5f);
        c.i32Eq();
        c.i32Or();
      };

      // REOP_line_start(_m)/line_end(_m) (libregexp.c:2995-3014): the
      // DESIGN PAPER-TRACE (findings-p1-v1.txt, written BEFORE this
      // code) resolves the short-circuit need by computing a FLAT fail
      // flag FIRST, then ONE failIf at the outer level — the gotoNoMatch
      // call site never sits any deeper than failIf's own proven "+1",
      // no matter how much nested control flow it took to compute the
      // flag safely. isMultiline is TS-compile-time (line_start vs
      // line_start_m are separate REOP values, like emitDotOrAny's own
      // isAny split) — non-multiline reduces to a FLAT failIf directly,
      // no scratch local or nested control flow needed at all.
      const emitLineStart = (isMultiline: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          if (!isMultiline) {
            failIf(() => {
              c.localGet(CPTR);
              c.i32Const(0);
              c.i32Ne();
            }, continueLoopDepth);
            return;
          }
          c.i32Const(0);
          c.localSet(MATCHED); // reused as the FAIL flag here, not a rangeSearch result
          c.localGet(CPTR);
          c.i32Const(0);
          c.i32Ne();
          c.ifVoid();
          // cptr != 0 here — PEEK_PREV_CHAR is provably safe.
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.peekPrevChar());
          c.localSet(C_CHAR);
          emitIsLineTerminator(C_CHAR);
          c.i32Eqz();
          c.localSet(MATCHED);
          c.end();
          failIf(() => c.localGet(MATCHED), continueLoopDepth);
        };
      };

      const emitLineEnd = (isMultiline: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          if (!isMultiline) {
            failIf(() => {
              c.localGet(CPTR);
              c.localGet(SUBJECT);
              c.arrayLen();
              c.i32Ne();
            }, continueLoopDepth);
            return;
          }
          c.i32Const(0);
          c.localSet(MATCHED);
          c.localGet(CPTR);
          c.localGet(SUBJECT);
          c.arrayLen();
          c.i32Ne();
          c.ifVoid();
          // cptr != subject.length here — PEEK_CHAR is provably safe.
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.peekChar());
          c.localSet(C_CHAR);
          emitIsLineTerminator(C_CHAR);
          c.i32Eqz();
          c.localSet(MATCHED);
          c.end();
          failIf(() => c.localGet(MATCHED), continueLoopDepth);
        };
      };

      // REOP_word_boundary(_i)/not_word_boundary(_i) (libregexp.c:3150-
      // 3183): the SAME "compute flat locals first, one failIf at the
      // end" shape, applied to TWO independent side-results (V1: is
      // the char BEFORE cptr a word byte; V2: is the char AT cptr).
      // Both default to 0 (false — the reference's own `v1 = false`/
      // `v2 = false` at each side's respective subject boundary); a
      // guard ifVoid contains a peek followed by TWO SIBLING ifVoids
      // (c<256 / c>=256, mutually exclusive and jointly exhaustive —
      // NOT nested in each other, so neither adds depth the other
      // needs to account for) overriding V1/V2 with the ASCII
      // word-byte formula or the ignoreCase-gated KELVIN SIGN (0x212a)
      // / LATIN SMALL LETTER LONG S (0x17f) special case respectively.
      // `isBoundary` (also TS-compile-time) folds into the final check
      // ALGEBRAICALLY: `v1^v2^is_boundary` becomes a flat i32Xor, plus
      // one i32Eqz ONLY when isBoundary is compile-time true (X^1 =
      // !X) — still exactly one flat i32 boolean, no extra nesting.
      const emitWordBoundary = (isBoundary: boolean, ignoreCase: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          c.i32Const(0);
          c.localSet(V1);
          c.localGet(CPTR);
          c.i32Const(0);
          c.i32Ne();
          c.ifVoid();
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.peekPrevChar());
          c.localSet(C_CHAR);
          c.localGet(C_CHAR);
          c.i32Const(256);
          c.i32LtS();
          c.ifVoid();
          emitIsWordByte(C_CHAR);
          c.localSet(V1);
          c.end();
          c.localGet(C_CHAR);
          c.i32Const(256);
          c.i32GeS();
          c.ifVoid();
          c.i32Const(ignoreCase ? 1 : 0);
          c.localGet(C_CHAR);
          c.i32Const(0x017f);
          c.i32Eq();
          c.localGet(C_CHAR);
          c.i32Const(0x212a);
          c.i32Eq();
          c.i32Or();
          c.i32And();
          c.localSet(V1);
          c.end();
          c.end();

          c.i32Const(0);
          c.localSet(V2);
          c.localGet(CPTR);
          c.localGet(SUBJECT);
          c.arrayLen();
          c.i32LtS();
          c.ifVoid();
          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(IS_UNICODE);
          c.call(this.peekChar());
          c.localSet(C_CHAR);
          c.localGet(C_CHAR);
          c.i32Const(256);
          c.i32LtS();
          c.ifVoid();
          emitIsWordByte(C_CHAR);
          c.localSet(V2);
          c.end();
          c.localGet(C_CHAR);
          c.i32Const(256);
          c.i32GeS();
          c.ifVoid();
          c.i32Const(ignoreCase ? 1 : 0);
          c.localGet(C_CHAR);
          c.i32Const(0x017f);
          c.i32Eq();
          c.localGet(C_CHAR);
          c.i32Const(0x212a);
          c.i32Eq();
          c.i32Or();
          c.i32And();
          c.localSet(V2);
          c.end();
          c.end();

          failIf(() => {
            c.localGet(V1);
            c.localGet(V2);
            c.i32Xor();
            if (isBoundary) c.i32Eqz();
          }, continueLoopDepth);
        };
      };

      // computeRegIdx(): idx = 2*CAPTURE_COUNT + REG — the register
      // family's own shared address computation (libregexp.c's own
      // `idx = 2 * s->capture_count + pc[0]`, appearing at every one
      // of set_i32/loop/loop_split_*/set_char_pos/check_advance's own
      // case blocks). Leaves the computed idx on the stack; callers
      // localSet it into IDX.
      const computeRegIdx = (): void => {
        c.i32Const(2);
        c.localGet(CAPTURE_COUNT);
        c.i32Mul();
        c.localGet(REG);
        c.i32Add();
      };

      // saveRegister(idx, value): the register family's own shared
      // "read REG's undo-checked write" tail — call saveCaptureCheck
      // and store its two results back into STACK/SP, matching every
      // OTHER caller of a 2-result stack-mutating primitive in this
      // file (e.g. emitSaveCapture's own ensureStackSpace call).
      const saveRegister = (): void => {
        c.localGet(STACK);
        c.localGet(SP);
        c.localGet(BP);
        c.localGet(CAPTURE_OUT);
        c.localGet(IDX);
        c.localGet(NEW_COUNTER);
        c.call(this.saveCaptureCheck());
        c.localSet(SP);
        c.localSet(STACK);
      };

      // REOP_set_i32 (libregexp.c:3067-3072): idx = 2*captureCount+reg;
      // val = read u32; ONE saveCaptureCheck call. No fail path in the
      // reference at all.
      const emitSetI32 = (): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(REG);
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.call(this.readU32());
        c.localSet(NEW_COUNTER); // reused here as "the value to write", not a decremented counter
        c.localGet(PC);
        c.i32Const(5);
        c.i32Add();
        c.localSet(PC);
        computeRegIdx();
        c.localSet(IDX);
        saveRegister();
      };

      // REOP_loop (libregexp.c:3073-3088, minus the timeout poll — see
      // noMatch's own doc comment on why that's not ported): read
      // reg+offset (offset SIGNED, relative to the position AFTER the
      // operand — the SAME convention goto/split already use);
      // newCounter = captureOut[idx]-1; ONE saveCaptureCheck call; if
      // (newCounter!=0) pc += offset. No fail path.
      const emitLoop = (): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(REG);
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.call(this.readU32());
        c.localSet(VAL); // the relative offset
        c.localGet(PC);
        c.i32Const(5);
        c.i32Add();
        c.localSet(PC); // pc now points PAST the operand — base for the relative jump
        computeRegIdx();
        c.localSet(IDX);
        c.localGet(CAPTURE_OUT);
        c.localGet(IDX);
        c.arrayGet(this.capType);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(NEW_COUNTER);
        saveRegister();
        c.localGet(NEW_COUNTER);
        c.i32Const(0);
        c.i32Ne();
        c.ifVoid();
        c.localGet(PC);
        c.localGet(VAL);
        c.i32Add();
        c.localSet(PC);
        c.end();
      };

      // REOP_set_char_pos (libregexp.c:3139-3143): idx=2*captureCount+
      // reg; ONE saveCaptureCheck call writing CPTR itself (a POSITION
      // snapshot, not a counter). No fail path.
      const emitSetCharPos = (): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(REG);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.localSet(PC);
        computeRegIdx();
        c.localSet(IDX);
        c.localGet(CPTR);
        c.localSet(NEW_COUNTER); // reused as "the value to write" — here a position, not a counter
        saveRegister();
      };

      // REOP_check_advance (libregexp.c:3144-3149): idx=2*captureCount
      // +reg; ONE flat failIf(() => captureOut[idx]==cptr) — exactly as
      // simple as non-multiline line_start's own single-condition
      // failIf (this file's own established shape for "no nested
      // control flow needed at all").
      const emitCheckAdvance = (continueLoopDepth: number): void => {
        c.localGet(BYTECODE);
        c.localGet(PC);
        c.call(this.readU8());
        c.localSet(REG);
        c.localGet(PC);
        c.i32Const(1);
        c.i32Add();
        c.localSet(PC);
        computeRegIdx();
        c.localSet(IDX);
        failIf(() => {
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.arrayGet(this.capType);
          c.localGet(CPTR);
          c.i32Eq();
        }, continueLoopDepth);
      };

      // REOP_loop_split_{goto,next}_first / REOP_loop_check_adv_split_
      // {goto,next}_first (libregexp.c:3089-3138): the register
      // family's own conditional split. isNextFirst mirrors plain
      // split's own meaning; checkAdvance is TS-compile-time (4
      // separate REOP values). The reference's OWN branch structure —
      // `if (val2>limit) jump; else { if (checkAdvance-guard) fail; if
      // (val2!=0) conditional-split }` — collapses into ONE flat
      // failIf whose condition ALREADY encodes the reference's own
      // branch guard algebraically: `(newCounter<=limit) &&
      // checkAdvance && (captureOut[idx+1]==cptr) && (newCounter!=
      // limit)` — the `newCounter<=limit` conjunct makes the WHOLE
      // expression false whenever the reference would have taken the
      // "jump" branch instead (where the guard is never evaluated), so
      // no genuine short-circuit is needed: every conjunct is a SAFE
      // array read/comparison (idx+1 is always in-bounds by the
      // assembler's own construction, the same trust already extended
      // to save_start/end's own indexing) — one flat i32And chain
      // computes the IDENTICAL branch selection the reference's nested
      // if/else does. AFTER that one failIf (which contains no OTHER
      // control flow, needing nothing beyond failIf's own "+1"), the
      // STRUCTURAL choice (jump vs push-a-split vs fall through) is
      // genuine runtime if/else — safe to nest freely since NEITHER
      // branch calls gotoNoMatch (the only fail check already
      // happened, flatly, before this section) — reusing
      // pushSplitEntry, not re-deriving the split-push a second time.
      const emitLoopSplit = (isNextFirst: boolean, checkAdvance: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU8());
          c.localSet(REG);
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.i32Const(1);
          c.i32Add();
          c.call(this.readU32());
          c.localSet(LIMIT);
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.i32Const(5);
          c.i32Add();
          c.call(this.readU32());
          c.localSet(VAL); // the relative offset, same local pushSplitEntry expects
          c.localGet(PC);
          c.i32Const(9);
          c.i32Add();
          c.localSet(PC); // pc now points PAST the whole 9-byte operand
          computeRegIdx();
          c.localSet(IDX);
          c.localGet(CAPTURE_OUT);
          c.localGet(IDX);
          c.arrayGet(this.capType);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(NEW_COUNTER);
          saveRegister();

          if (checkAdvance) {
            failIf(() => {
              c.localGet(NEW_COUNTER);
              c.localGet(LIMIT);
              c.i32LeS();
              c.localGet(CAPTURE_OUT);
              c.localGet(IDX);
              c.i32Const(1);
              c.i32Add();
              c.arrayGet(this.capType);
              c.localGet(CPTR);
              c.i32Eq();
              c.i32And();
              c.localGet(NEW_COUNTER);
              c.localGet(LIMIT);
              c.i32Ne();
              c.i32And();
            }, continueLoopDepth);
          }

          c.localGet(NEW_COUNTER);
          c.localGet(LIMIT);
          c.i32GtS();
          c.ifVoid();
          // "normal loop": unconditional jump, same shape as emitLoop's own.
          c.localGet(PC);
          c.localGet(VAL);
          c.i32Add();
          c.localSet(PC);
          c.else_();
          c.localGet(NEW_COUNTER);
          c.i32Const(0);
          c.i32Ne();
          c.ifVoid();
          pushSplitEntry(isNextFirst);
          c.end();
          c.end();
        };
      };

      // REOP_lookahead/REOP_negative_lookahead (libregexp.c:2977-2988):
      // reads the CONTINUATION offset (reached once the matching
      // _match opcode fires — NOT a redirect of pc itself: dispatch
      // continues SEQUENTIALLY into the lookahead's own body, which the
      // assembler emits immediately following this instruction),
      // pushes (continuation-pc, cptr, bp, LOOKAHEAD+isNegative), bp=sp.
      // Deliberately NOT built on pushSplitEntry: that closure ALWAYS
      // redirects pc based on isNextFirst, which is exactly what a
      // lookahead must NOT do (pc stays pointing at the body).
      const emitLookaheadPush = (isNegative: boolean): (() => void) => {
        return () => {
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU32());
          c.localSet(VAL);
          c.localGet(PC);
          c.i32Const(4);
          c.i32Add();
          c.localSet(PC); // pc now points PAST the operand, at the body — never redirected
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(4);
          c.call(this.ensureStackSpace());
          c.localSet(STACK);
          c.localGet(STACK);
          c.localGet(SP);
          c.localGet(PC);
          c.localGet(VAL);
          c.i32Add(); // the continuation point: pc + val
          c.arraySet(this.capType);
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(1);
          c.i32Add();
          c.localGet(CPTR);
          c.arraySet(this.capType);
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(2);
          c.i32Add();
          c.localGet(BP);
          c.arraySet(this.capType);
          c.localGet(STACK);
          c.localGet(SP);
          c.i32Const(3);
          c.i32Add();
          c.i32Const(isNegative ? RE_EXEC_STATE_NEGATIVE_LOOKAHEAD : RE_EXEC_STATE_LOOKAHEAD);
          c.arraySet(this.capType);
          c.localGet(SP);
          c.i32Const(4);
          c.i32Add();
          c.localSet(SP);
          c.localGet(SP);
          c.localSet(BP);
        };
      };

      // REOP_lookahead_match (libregexp.c:2884-2916): the lookahead's
      // body just SUCCEEDED. lookaheadMatch() does the whole compaction
      // (findings-p1-v1.txt's own design-trace entry has the hand-
      // traced equivalence proof against the reference's own packed-
      // pointer version) — this handler just calls it and threads the
      // results back into the dispatch loop's own locals. No fail path.
      const emitLookaheadMatch = (): void => {
        c.localGet(STACK);
        c.localGet(SP);
        c.localGet(BP);
        c.call(this.lookaheadMatch());
        // Results declared [newStack, newPc, newCptr, newBp, newSp] —
        // popped in REVERSE declaration order, this file's own
        // established convention.
        c.localSet(SP);
        c.localSet(BP);
        c.localSet(CPTR);
        c.localSet(PC);
        c.localSet(STACK);
      };

      // REOP_negative_lookahead_match (libregexp.c:2917-2935): the
      // negative lookahead's body just SUCCEEDED, which means the
      // negative lookahead itself must FAIL. unwindToType(NEGATIVE_
      // LOOKAHEAD) does the first half (undo back through its own
      // marker, via the SAME parameterized noMatch gotoNoMatch itself
      // uses); the STANDARD gotoNoMatch does the second — TWO VISIBLE
      // calls in sequence, exactly mirroring the reference's own
      // "separate loop, then goto no_match" structure (findings-
      // p1-v1.txt's own design-trace entry — the lead's FINAL ruling,
      // reconsidering an earlier leaning toward a dedicated second
      // loop, since this loop and gotoNoMatch's own share their ENTIRE
      // per-iteration body and differ in exactly one constant, which is
      // parameterization's legitimate case, not the \S-style
      // conflation the earlier leaning was guarding against).
      const emitNegativeLookaheadMatch = (continueLoopDepth: number): void => {
        unwindToType(RE_EXEC_STATE_NEGATIVE_LOOKAHEAD, false);
        gotoNoMatch(continueLoopDepth);
      };

      // REOP_back_reference(_i)/backward_back_reference(_i) (libregexp.c:
      // 3184-3240): reads n (u8) candidate capture-group indices, finds
      // the FIRST one whose capture is actually SET (both slots != -1
      // — "test the first not empty capture", n genuinely exceeding 1
      // for ES2025's duplicate named capture groups across alternation,
      // confirmed reachable by probing this port's own assembler
      // directly), then calls backRefCompare() once with that
      // candidate's own bounds. The SEARCH loop has NO fail path at
      // all — it either overrides CAP_START/CAP_END or falls through
      // with the DEFAULT (both 0), which makes backRefCompare's own
      // loop run ZERO iterations and report success immediately,
      // exactly ECMA-262's own "an unset backreference matches empty"
      // rule via the default value itself rather than a special-cased
      // branch — so no br-depth arithmetic is needed for the search
      // loop either. This leaves emitBackReference with the SAME flat
      // shape as every other opcode handler: read operands, a
      // structural (non-failing) loop, ONE call to a standalone
      // primitive, ONE flat failIf on its boolean result.
      const emitBackReference = (isBackward: boolean, ignoreCase: boolean): ((continueLoopDepth: number) => void) => {
        return (continueLoopDepth: number) => {
          c.localGet(BYTECODE);
          c.localGet(PC);
          c.call(this.readU8());
          c.localSet(N);
          c.localGet(PC);
          c.i32Const(1);
          c.i32Add();
          c.localSet(PC);
          c.localGet(PC); // TABLE_POS: where the n index bytes begin
          c.localSet(TABLE_POS);
          c.localGet(PC);
          c.localGet(N);
          c.i32Add();
          c.localSet(PC); // pc now points PAST the n index bytes

          c.i32Const(0);
          c.localSet(CAP_START);
          c.i32Const(0);
          c.localSet(CAP_END);
          c.i32Const(0);
          c.localSet(I);
          c.loop();
          c.localGet(I);
          c.localGet(N);
          c.i32LtS();
          c.ifVoid();
          c.localGet(BYTECODE);
          c.localGet(TABLE_POS);
          c.localGet(I);
          c.i32Add();
          c.call(this.readU8());
          c.localSet(VAL); // the candidate's own capture-group index
          c.localGet(CAPTURE_OUT);
          c.localGet(VAL);
          c.i32Const(2);
          c.i32Mul();
          c.arrayGet(this.capType);
          c.localSet(S0);
          c.localGet(CAPTURE_OUT);
          c.localGet(VAL);
          c.i32Const(2);
          c.i32Mul();
          c.i32Const(1);
          c.i32Add();
          c.arrayGet(this.capType);
          c.localSet(S1);
          c.localGet(S0);
          c.i32Const(-1);
          c.i32Ne();
          c.localGet(S1);
          c.i32Const(-1);
          c.i32Ne();
          c.i32And();
          c.ifVoid();
          // FOUND: override CAP_START/CAP_END, do NOT continue the search.
          c.localGet(S0);
          c.localSet(CAP_START);
          c.localGet(S1);
          c.localSet(CAP_END);
          c.else_();
          // not found: I += 1, continue searching. TWO enclosing blocks
          // sit between here and the loop (this found/else ifVoid, then
          // the "I<N" ifVoid) — br(2), not br(1); hand-traced and
          // caught BEFORE running anything, not after a wrong result
          // (this port's search fixture below is specifically built to
          // scan PAST a non-matching first candidate, which a br(1)
          // mistake here would have exited on instead of continuing).
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          c.br(2); // continue the search loop
          c.end();
          c.end();
          c.end(); // search loop — reached ONLY via I>=N or FOUND, never by falling off mid-scan

          c.localGet(SUBJECT);
          c.localGet(CPTR);
          c.localGet(CAP_START);
          c.localGet(CAP_END);
          c.localGet(IS_UNICODE);
          c.i32Const(isBackward ? 1 : 0);
          c.i32Const(ignoreCase ? 1 : 0);
          c.call(this.backRefCompare());
          // Results declared [matches, newCptr] — popped in REVERSE
          // declaration order.
          c.localSet(NEW_CPTR);
          c.localSet(MATCHED);
          c.localGet(NEW_CPTR);
          c.localSet(CPTR);
          failIf(() => {
            c.localGet(MATCHED);
            c.i32Eqz();
          }, continueLoopDepth);
        };
      };

      c.loop();
      c.localGet(BYTECODE);
      c.localGet(PC);
      c.call(this.readU8());
      c.localSet(OPCODE);
      c.localGet(PC);
      c.i32Const(1);
      c.i32Add();
      c.localSet(PC);
      this.emitSwitch(
        c,
        () => c.localGet(OPCODE),
        45,
        new Map([
          [REOP.char, emitTestChar(false, false)],
          [REOP.char32, emitTestChar(true, false)],
          [REOP.char_i, emitTestChar(false, true)],
          [REOP.char32_i, emitTestChar(true, true)],
          [REOP.dot, emitDotOrAny(false)],
          [REOP.any, emitDotOrAny(true)],
          [REOP.save_start, emitSaveCapture(0)],
          [REOP.save_end, emitSaveCapture(1)],
          [REOP.save_reset, emitSaveReset],
          [REOP.split_goto_first, emitSplit(false)],
          [REOP.split_next_first, emitSplit(true)],
          [REOP.goto, emitGoto],
          [REOP.prev, emitPrev],
          [REOP.range, emitRangeTest(false, false)],
          [REOP.range_i, emitRangeTest(false, true)],
          [REOP.range32, emitRangeTest(true, false)],
          [REOP.range32_i, emitRangeTest(true, true)],
          [REOP.space, emitSpaceTest(false)],
          [REOP.not_space, emitSpaceTest(true)],
          [REOP.line_start, emitLineStart(false)],
          [REOP.line_start_m, emitLineStart(true)],
          [REOP.line_end, emitLineEnd(false)],
          [REOP.line_end_m, emitLineEnd(true)],
          [REOP.word_boundary, emitWordBoundary(true, false)],
          [REOP.word_boundary_i, emitWordBoundary(true, true)],
          [REOP.not_word_boundary, emitWordBoundary(false, false)],
          [REOP.not_word_boundary_i, emitWordBoundary(false, true)],
          [REOP.set_i32, emitSetI32],
          [REOP.loop, emitLoop],
          [REOP.set_char_pos, emitSetCharPos],
          [REOP.check_advance, emitCheckAdvance],
          [REOP.loop_split_goto_first, emitLoopSplit(false, false)],
          [REOP.loop_split_next_first, emitLoopSplit(true, false)],
          [REOP.loop_check_adv_split_goto_first, emitLoopSplit(false, true)],
          [REOP.loop_check_adv_split_next_first, emitLoopSplit(true, true)],
          [REOP.lookahead, emitLookaheadPush(false)],
          [REOP.negative_lookahead, emitLookaheadPush(true)],
          [REOP.lookahead_match, emitLookaheadMatch],
          [REOP.negative_lookahead_match, emitNegativeLookaheadMatch],
          [REOP.back_reference, emitBackReference(false, false)],
          [REOP.back_reference_i, emitBackReference(false, true)],
          [REOP.backward_back_reference, emitBackReference(true, false)],
          [REOP.backward_back_reference_i, emitBackReference(true, true)],
          [
            REOP.match,
            () => {
              c.i32Const(1);
              c.return_();
            },
          ],
        ]),
        () => c.unreachable(), // opcode this slice doesn't implement yet — never guess
      );
      c.end(); // loop
      c.unreachable(); // every case either returns or continues the loop; falling off is a bug

      this.mb.setBody(
        idx,
        [
          I32,
          I32,
          I32,
          I32,
          this.capRefType(),
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
          I32,
          I32,
          this.bcRefType(),
          this.bcRefType(),
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
          I32,
        ],
        c.bytes(),
      );
      return idx;
    });
  }
}
