/* ECMA-262 Default Case Conversion (String.prototype.toLowerCase /
 * toUpperCase) — a flat wasm port of the vendored quickjs-ng libunicode's
 * lre_case_conv + the two predicates (lre_is_cased, lre_is_case_ignorable)
 * over the (array (mut i16)) UTF-16 storage — the C lane's port target,
 * scr_regex.c's scr_str_case_conv/scr_final_sigma, ported again here with
 * the UTF-8 walk replaced by surrogate-pair-aware UTF-16 stepping.
 *
 * conv_type ∈ {0 (upper), 1 (lower)} ONLY: JS never asks for case FOLDING
 * (conv_type 2, quickjs.c's lre_canonicalize/regex path) — every
 * `conv_type == 2` arm and the self-recursive lre_case_conv1 call it
 * guards (libunicode.c:129,130,142,143,144) are dead code here and are
 * NOT ported. Measured: running the fold arms for toLowerCase disagrees
 * with Node on 269 code points (increment-20-design.md / rev-preread.md).
 *
 * Citation ranges (measured against the actual file, not assumed):
 * lre_case_conv + lre_case_conv_entry = libunicode.c:52-188.
 * libunicode.c:189-263 is lre_case_folding_entry/lre_canonicalize —
 * regex-only, NOT ported. The two predicates + the compressed-bitmap
 * decoder live at libunicode.c:264-370 (get_le24, get_index_pos,
 * lre_is_in_table, lre_is_cased, lre_is_case_ignorable).
 *
 * Tables: six passive-data-segment arrays (casing-tables.ts, GENERATED
 * from the vendored header), materialized ONCE into (ref null (array T))
 * globals on first use — numfmt.ts's buildF64ToStr precedent
 * (array.new_data is not a GC constexpr, increment-13 lesson). Unlike
 * numfmt.ts (one entry point), this module has several public entry
 * points sharing the same tables, so the guard is its OWN callable
 * function (ensureInit) rather than inlined at every call site — called
 * at the top of every function that touches a table directly. gInitCount
 * is a readable structural pin: it must read exactly 1 after any number
 * of calls to any entry point, in any order (the "idempotence is
 * otherwise behaviorally unfalsifiable" pin from rev-inc20's pre-read).
 *
 * The UTF-16 walk (decodeFwd/decodeBack) is surrogate-pair-aware in BOTH
 * directions — load-bearing per rev-inc20's discriminating pins: a naive
 * one-code-unit step at an astral boundary is a live miscompile in both
 * directions (a lone surrogate is neither Cased nor Case_Ignorable, so it
 * silently terminates a scan instead of stepping over its pair partner).
 * Every "is there a partner code unit" check is REAL nested control flow
 * (if/end), never i32.and with an unguarded array read as the right
 * operand — i32.and does not short-circuit, and the array reads here are
 * genuinely only valid once the length/index guard holds
 * ([[tsinter-lessons]]). Several PURE scalar comparisons (no memory
 * access on either side, e.g. combining a two-sided range check on an
 * already-loaded code unit, or two `type ==` tests before dispatch) use
 * i32.and/i32.or directly — safe by construction, called out inline.
 *
 * Stage A (this file): builder-level only. emitter.ts's strIntrinsic
 * refusal for toLowerCase/toUpperCase (emitter.ts:7534-7540) is
 * UNCHANGED — the gate opens in stage B once the full surface (astral,
 * Final_Sigma, growth, predicates) has its pin suite green. Living in its
 * own file rather than strings.ts: strings.ts's own header already calls
 * case conversion out as "a separate rock" needing libunicode's tables,
 * and every other cross-cutting concern here (maps, arrays, unions, bytes,
 * generators, promises, json, inspect, dyn, timers, numfmt) gets its own
 * file — numfmt.ts (another table-heavy, single-purpose module) is the
 * closest analog, and it isn't inside strings.ts either.
 */
import type { ByteWriter } from "./bytes.js";
import { Code } from "./code.js";
import { I32, ModuleBuilder, type ValType } from "./module.js";
import {
  CASE_CONV_EXT,
  CASE_CONV_TABLE1,
  CASE_CONV_TABLE2,
  UNICODE_PROP_CASED1_INDEX,
  UNICODE_PROP_CASED1_TABLE,
  UNICODE_PROP_CASE_IGNORABLE_INDEX,
  UNICODE_PROP_CASE_IGNORABLE_TABLE,
} from "./casing-tables.js";

function u32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    bytes[i * 4] = v & 0xff;
    bytes[i * 4 + 1] = (v >>> 8) & 0xff;
    bytes[i * 4 + 2] = (v >>> 16) & 0xff;
    bytes[i * 4 + 3] = (v >>> 24) & 0xff;
  });
  return bytes;
}

function u16Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((v, i) => {
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >>> 8) & 0xff;
  });
  return bytes;
}

function u8Bytes(values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

export class CasingBuilder {
  private readonly fns = new Map<string, number>();

  // Array type indices. table2/casedTable/casedIndex/ciTable/ciIndex are
  // all immutable (array i8) — module.ts's arrayType interns by shape, so
  // all five collapse onto ONE type index (i8ArrType) automatically.
  private readonly table1Type: number;
  private readonly extType: number;
  private readonly i8ArrType: number;

  // Data-segment byte offsets, interned once in the constructor (this
  // class is only ever instantiated lazily, on first actual reference —
  // emitter.ts's `get casing()` mirrors `get strs()` — so a module that
  // never touches case conversion never pays for this).
  private readonly table1Offset: number;
  private readonly table2Offset: number;
  private readonly extOffset: number;
  private readonly casedTableOffset: number;
  private readonly casedIndexOffset: number;
  private readonly ciTableOffset: number;
  private readonly ciIndexOffset: number;

  // Lazily-materialized table globals + the structural init-count pin.
  private readonly gTable1: number;
  private readonly gTable2: number;
  private readonly gExt: number;
  private readonly gCasedTable: number;
  private readonly gCasedIndex: number;
  private readonly gCiTable: number;
  private readonly gCiIndex: number;
  private readonly gInitCount: number;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly strType: number,
  ) {
    this.table1Type = mb.arrayType(I32, false);
    this.extType = mb.arrayType("i16", false);
    this.i8ArrType = mb.arrayType("i8", false);

    this.table1Offset = mb.internData(u32Bytes(CASE_CONV_TABLE1));
    this.table2Offset = mb.internData(u8Bytes(CASE_CONV_TABLE2));
    this.extOffset = mb.internData(u16Bytes(CASE_CONV_EXT));
    this.casedTableOffset = mb.internData(u8Bytes(UNICODE_PROP_CASED1_TABLE));
    this.casedIndexOffset = mb.internData(u8Bytes(UNICODE_PROP_CASED1_INDEX));
    this.ciTableOffset = mb.internData(u8Bytes(UNICODE_PROP_CASE_IGNORABLE_TABLE));
    this.ciIndexOffset = mb.internData(u8Bytes(UNICODE_PROP_CASE_IGNORABLE_INDEX));

    const table1Ref: ValType = { kind: "ref", nullable: true, typeIndex: this.table1Type };
    const extRef: ValType = { kind: "ref", nullable: true, typeIndex: this.extType };
    const i8Ref: ValType = { kind: "ref", nullable: true, typeIndex: this.i8ArrType };
    const nullInit = (typeIndex: number) => (w: ByteWriter) => {
      w.u8(0xd0);
      w.sleb(typeIndex);
    };
    this.gTable1 = mb.addGlobal(table1Ref, true, nullInit(this.table1Type));
    this.gTable2 = mb.addGlobal(i8Ref, true, nullInit(this.i8ArrType));
    this.gExt = mb.addGlobal(extRef, true, nullInit(this.extType));
    this.gCasedTable = mb.addGlobal(i8Ref, true, nullInit(this.i8ArrType));
    this.gCasedIndex = mb.addGlobal(i8Ref, true, nullInit(this.i8ArrType));
    this.gCiTable = mb.addGlobal(i8Ref, true, nullInit(this.i8ArrType));
    this.gCiIndex = mb.addGlobal(i8Ref, true, nullInit(this.i8ArrType));
    this.gInitCount = mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const
      w.sleb(0);
    });
  }

  /** The structural init-guard pin: a test can read this global (via a
   * tiny exported accessor) and assert it is exactly 1 after any number
   * of calls, in any order, to any entry point — idempotence is
   * otherwise behaviorally unfalsifiable (rev-inc20's pin). */
  initCountGlobal(): number {
    return this.gInitCount;
  }

  private i8ArrRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.i8ArrType };
  }

  private strRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.strType };
  }

  private cached(name: string, build: () => number): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = build();
    this.fns.set(name, idx);
    return idx;
  }

  /** %w.str.caseInit() — the shared lazy-materialization guard, called at
   * the top of every function that touches a table directly (findCaseRange,
   * caseConvEntry, isCased, isCaseIgnorable). One representative global
   * (gTable1) gates all seven — they are always filled together, exactly
   * numfmt.ts's guard shape generalized to multiple call sites. */
  private ensureInit(): number {
    return this.cached("init", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([], []), "%w.str.caseInit");
      const c = new Code();
      c.globalGet(this.gTable1);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(this.table1Offset);
      c.i32Const(CASE_CONV_TABLE1.length);
      c.arrayNewData(this.table1Type, 0);
      c.globalSet(this.gTable1);
      c.i32Const(this.table2Offset);
      c.i32Const(CASE_CONV_TABLE2.length);
      c.arrayNewData(this.i8ArrType, 0);
      c.globalSet(this.gTable2);
      c.i32Const(this.extOffset);
      c.i32Const(CASE_CONV_EXT.length);
      c.arrayNewData(this.extType, 0);
      c.globalSet(this.gExt);
      c.i32Const(this.casedTableOffset);
      c.i32Const(UNICODE_PROP_CASED1_TABLE.length);
      c.arrayNewData(this.i8ArrType, 0);
      c.globalSet(this.gCasedTable);
      c.i32Const(this.casedIndexOffset);
      c.i32Const(UNICODE_PROP_CASED1_INDEX.length);
      c.arrayNewData(this.i8ArrType, 0);
      c.globalSet(this.gCasedIndex);
      c.i32Const(this.ciTableOffset);
      c.i32Const(UNICODE_PROP_CASE_IGNORABLE_TABLE.length);
      c.arrayNewData(this.i8ArrType, 0);
      c.globalSet(this.gCiTable);
      c.i32Const(this.ciIndexOffset);
      c.i32Const(UNICODE_PROP_CASE_IGNORABLE_INDEX.length);
      c.arrayNewData(this.i8ArrType, 0);
      c.globalSet(this.gCiIndex);
      c.globalGet(this.gInitCount);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(this.gInitCount);
      c.end();
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseGetLe24(table, entryIdx) → i32 — get_le24 over an i8
   * array: 3 bytes at entryIdx*3, little-endian, as a plain arithmetic
   * combine (no control flow, no hazard — every read is unconditional
   * and always in-bounds by the caller's own index discipline). */
  private getLe24(): number {
    return this.cached("getLe24", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.i8ArrRef(), I32], [I32]),
        "%w.str.caseGetLe24",
      );
      const c = new Code();
      const TABLE = 0,
        ENTRY_IDX = 1,
        BASE = 2;
      c.localGet(ENTRY_IDX);
      c.i32Const(3);
      c.i32Mul();
      c.localSet(BASE);
      c.localGet(TABLE);
      c.localGet(BASE);
      c.arrayGetU(this.i8ArrType);
      c.localGet(TABLE);
      c.localGet(BASE);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.i8ArrType);
      c.i32Const(8);
      c.i32Shl();
      c.i32Or();
      c.localGet(TABLE);
      c.localGet(BASE);
      c.i32Const(2);
      c.i32Add();
      c.arrayGetU(this.i8ArrType);
      c.i32Const(16);
      c.i32Shl();
      c.i32Or();
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseIndexPos(cp, index, indexLen) → (pos, code) —
   * get_index_pos's binary search over the 3-byte-packed index table
   * (libunicode.c:272-303), byte-exact. `indexLen` is the ENTRY count
   * (index array byte length / 3), matching the C call sites' own
   * `sizeof(...)/3` — NOT the raw byte length (a transcription trap
   * caught while wiring isCased/isCaseIgnorable below). */
  private getIndexPos(): number {
    return this.cached("indexPos", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([I32, this.i8ArrRef(), I32], [I32, I32]),
        "%w.str.caseIndexPos",
      );
      const c = new Code();
      const CP = 0,
        INDEX = 1,
        INDEX_LEN = 2,
        V = 3,
        CODE = 4,
        IDX_MIN = 5,
        IDX_MAX = 6,
        IDX = 7;
      const le24 = this.getLe24();

      c.localGet(INDEX);
      c.i32Const(0);
      c.call(le24);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(0x1fffff);
      c.i32And();
      c.localSet(CODE);
      c.localGet(CP);
      c.localGet(CODE);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0); // pos
      c.i32Const(0); // code
      c.return_();
      c.end();

      c.localGet(INDEX_LEN);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(IDX_MAX);
      c.localGet(INDEX);
      c.localGet(IDX_MAX);
      c.call(le24);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(0x1fffff);
      c.i32And();
      c.localSet(CODE);
      c.localGet(CP);
      c.localGet(CODE);
      c.i32GeS();
      c.ifVoid();
      c.i32Const(-1); // pos
      c.i32Const(0); // code
      c.return_();
      c.end();

      c.i32Const(0);
      c.localSet(IDX_MIN);
      c.block();
      c.loop();
      // while (idx_max - idx_min) > 1
      c.localGet(IDX_MAX);
      c.localGet(IDX_MIN);
      c.i32Sub();
      c.i32Const(1);
      c.i32GtS();
      c.i32Eqz();
      c.brIf(1);
      c.localGet(IDX_MAX);
      c.localGet(IDX_MIN);
      c.i32Add();
      c.i32Const(1);
      c.i32ShrU();
      c.localSet(IDX);
      c.localGet(INDEX);
      c.localGet(IDX);
      c.call(le24);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(0x1fffff);
      c.i32And();
      c.localSet(CODE);
      c.localGet(CP);
      c.localGet(CODE);
      c.i32LtS();
      c.ifVoid();
      c.localGet(IDX);
      c.localSet(IDX_MAX);
      c.end();
      c.localGet(CP);
      c.localGet(CODE);
      c.i32GeS();
      c.ifVoid();
      c.localGet(IDX);
      c.localSet(IDX_MIN);
      c.end();
      c.br(0);
      c.end();
      c.end();

      c.localGet(INDEX);
      c.localGet(IDX_MIN);
      c.call(le24);
      c.localSet(V);
      // pos = (idx_min+1)*32 + (v >>> 21)
      c.localGet(IDX_MIN);
      c.i32Const(1);
      c.i32Add();
      c.i32Const(32);
      c.i32Mul();
      c.localGet(V);
      c.i32Const(21);
      c.i32ShrU();
      c.i32Add();
      // code = v & 0x1fffff
      c.localGet(V);
      c.i32Const(0x1fffff);
      c.i32And();
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseIsInTable(cp, table, index, indexLen) → i32 bool —
   * lre_is_in_table's run-length bitmap walk (libunicode.c:305-338),
   * byte-exact. HIGHEST-RISK port surface: in the whole corpus these
   * tables are reachable only through Final_Sigma on Σ-containing input,
   * so a decode bug here is nearly invisible behaviorally — this is why
   * it gets its own exhaustive predicate sweep (isCased/isCaseIgnorable,
   * both routed through this one shared function) rather than relying on
   * end-to-end case-conversion tests. The four byte-classification arms
   * (b<64 / b>=0x80 / 0x40<=b<0x60 / 0x60<=b<0x80) are mutually exclusive
   * over all of [0,255] by construction — written as an if/else_ chain,
   * not flat ANDs, since each arm's body performs its own array reads
   * that must not run for the wrong byte shape. The trailing
   * `unreachable()` is a type-checker satisfier, not a real path: the
   * loop only exits via `return bit` inside the walk (matches the C's own
   * `for(;;)` with no bound check — the table format is trusted to always
   * resolve before running off the array). */
  private isInTable(): number {
    return this.cached("isInTable", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([I32, this.i8ArrRef(), this.i8ArrRef(), I32], [I32]),
        "%w.str.caseIsInTable",
      );
      const c = new Code();
      const CP = 0,
        TABLE = 1,
        INDEX = 2,
        INDEX_LEN = 3,
        POS = 4,
        CODE = 5,
        BIT = 6,
        P = 7,
        B = 8;
      const indexPos = this.getIndexPos();

      c.localGet(CP);
      c.localGet(INDEX);
      c.localGet(INDEX_LEN);
      c.call(indexPos);
      c.localSet(CODE); // top = code (2nd declared result)
      c.localSet(POS); // next = pos (1st declared result)
      c.localGet(POS);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();

      c.localGet(POS);
      c.localSet(P);
      c.i32Const(0);
      c.localSet(BIT);

      c.loop();
      c.localGet(TABLE);
      c.localGet(P);
      c.arrayGetU(this.i8ArrType);
      c.localSet(B);
      c.localGet(P);
      c.i32Const(1);
      c.i32Add();
      c.localSet(P);

      c.localGet(B);
      c.i32Const(64);
      c.i32LtU();
      c.ifVoid();
      // arm 1: b < 64 — two packed runs.
      c.localGet(CODE);
      c.localGet(B);
      c.i32Const(3);
      c.i32ShrU();
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(CODE);
      c.localGet(CP);
      c.localGet(CODE);
      c.i32LtS();
      c.ifVoid();
      c.localGet(BIT);
      c.return_();
      c.end();
      c.localGet(BIT);
      c.i32Const(1);
      c.i32Xor();
      c.localSet(BIT);
      c.localGet(CODE);
      c.localGet(B);
      c.i32Const(7);
      c.i32And();
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(CODE);
      c.else_();
      c.localGet(B);
      c.i32Const(0x80);
      c.i32GeU();
      c.ifVoid();
      // arm 2: b >= 0x80 — single short run.
      c.localGet(CODE);
      c.localGet(B);
      c.i32Const(0x80);
      c.i32Sub();
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(CODE);
      c.else_();
      c.localGet(B);
      c.i32Const(0x60);
      c.i32LtU();
      c.ifVoid();
      // arm 3: 0x40 <= b < 0x60 (b >= 64 already guaranteed by the
      // enclosing else — matches the C's `else if (b < 0x60)`).
      c.localGet(CODE);
      c.localGet(B);
      c.i32Const(0x40);
      c.i32Sub();
      c.i32Const(8);
      c.i32Shl();
      c.localGet(TABLE);
      c.localGet(P);
      c.arrayGetU(this.i8ArrType);
      c.i32Or();
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(CODE);
      c.localGet(P);
      c.i32Const(1);
      c.i32Add();
      c.localSet(P);
      c.else_();
      // arm 4: 0x60 <= b < 0x80 — the C's final `else`.
      c.localGet(CODE);
      c.localGet(B);
      c.i32Const(0x60);
      c.i32Sub();
      c.i32Const(16);
      c.i32Shl();
      c.localGet(TABLE);
      c.localGet(P);
      c.arrayGetU(this.i8ArrType);
      c.i32Const(8);
      c.i32Shl();
      c.i32Or();
      c.localGet(TABLE);
      c.localGet(P);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.i8ArrType);
      c.i32Or();
      c.i32Const(1);
      c.i32Add();
      c.i32Add();
      c.localSet(CODE);
      c.localGet(P);
      c.i32Const(2);
      c.i32Add();
      c.localSet(P);
      c.end();
      c.end();
      c.end();

      // shared tail: if (c < code) return bit; bit ^= 1;
      c.localGet(CP);
      c.localGet(CODE);
      c.i32LtS();
      c.ifVoid();
      c.localGet(BIT);
      c.return_();
      c.end();
      c.localGet(BIT);
      c.i32Const(1);
      c.i32Xor();
      c.localSet(BIT);
      c.br(0);
      c.end(); // loop

      c.unreachable(); // never reached if the table format holds — see header note.
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.isCased(cp) → i32 bool — lre_is_cased's actual composition
   * (libunicode.c:340-363), VERIFIED against the source rather than
   * assumed: membership in ANY case_conv_table1 range means "cased"
   * regardless of that entry's direction gating, falling back to the
   * unicode_prop_Cased1 bitmap ONLY on a bisection miss. indexLen=6
   * (Cased1_index is 18 bytes / 3 per entry — the C call site's own
   * `sizeof(...)/3`, not the raw byte count). */
  isCased(): number {
    return this.cached("isCased", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.str.isCased");
      const c = new Code();
      const CP = 0;
      c.call(this.ensureInit());
      c.localGet(CP);
      c.call(this.findCaseRange());
      c.i32Const(-1);
      c.i32Ne();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(CP);
      c.globalGet(this.gCasedTable);
      c.globalGet(this.gCasedIndex);
      c.i32Const(UNICODE_PROP_CASED1_INDEX.length / 3);
      c.call(this.isInTable());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.isCaseIgnorable(cp) → i32 bool — pure bitmap membership, no
   * conv-table involvement (libunicode.c:365-370). indexLen=25
   * (Case_Ignorable_index is 75 bytes / 3 per entry). */
  isCaseIgnorable(): number {
    return this.cached("isCaseIgnorable", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.str.isCaseIgnorable");
      const c = new Code();
      const CP = 0;
      c.call(this.ensureInit());
      c.localGet(CP);
      c.globalGet(this.gCiTable);
      c.globalGet(this.gCiIndex);
      c.i32Const(UNICODE_PROP_CASE_IGNORABLE_INDEX.length / 3);
      c.call(this.isInTable());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.findCaseRange(cp) → idx | -1 — the case_conv_table1 bisection
   * (libunicode.c:170-188), factored into its own helper since the SAME
   * loop body is needed by both the conv-entry lookup and isCased's
   * first check (the C repeats this loop three times across
   * lre_case_conv/lre_canonicalize/lre_is_cased; we need it twice since
   * conv_type 2's lre_canonicalize path is dead here — still a DRY win
   * over transcribing it twice). */
  private findCaseRange(): number {
    return this.cached("findCaseRange", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([I32], [I32]), "%w.str.findCaseRange");
      const c = new Code();
      const CP = 0,
        IDX_MIN = 1,
        IDX_MAX = 2,
        IDX = 3,
        V = 4,
        CODE = 5,
        LEN = 6;
      c.call(this.ensureInit());
      c.i32Const(0);
      c.localSet(IDX_MIN);
      c.i32Const(CASE_CONV_TABLE1.length - 1);
      c.localSet(IDX_MAX);
      c.block();
      c.loop();
      c.localGet(IDX_MIN);
      c.localGet(IDX_MAX);
      c.i32GtS();
      c.brIf(1); // idx_min > idx_max -> not found
      c.localGet(IDX_MIN);
      c.localGet(IDX_MAX);
      c.i32Add();
      c.i32Const(1);
      c.i32ShrU();
      c.localSet(IDX);
      c.globalGet(this.gTable1);
      c.localGet(IDX);
      c.arrayGet(this.table1Type);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(15);
      c.i32ShrU();
      c.localSet(CODE);
      c.localGet(V);
      c.i32Const(8);
      c.i32ShrU();
      c.i32Const(0x7f);
      c.i32And();
      c.localSet(LEN);

      c.localGet(CP);
      c.localGet(CODE);
      c.i32LtS();
      c.ifVoid();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(IDX_MAX);
      c.br(1);
      c.end();

      c.localGet(CP);
      c.localGet(CODE);
      c.localGet(LEN);
      c.i32Add();
      c.i32GeS();
      c.ifVoid();
      c.localGet(IDX);
      c.i32Const(1);
      c.i32Add();
      c.localSet(IDX_MIN);
      c.br(1);
      c.end();

      // neither arm fired: found.
      c.localGet(IDX);
      c.return_();
      c.end(); // loop
      c.end(); // block
      c.i32Const(-1);
      this.mb.setBody(idx, [I32, I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseConvEntry(cp, convType, idx) → (count, r0, r1, r2) —
   * lre_case_conv_entry (libunicode.c:60-150) ported FLAT: every
   * `conv_type == 2` disjunct is dead (see header) and dropped, not
   * transcribed, so no arm here ever recurses (the ONLY call sites of
   * the self-recursive lre_case_conv1 are inside `conv_type == 2`
   * blocks). Dispatch is by exact `type` value, sequential and
   * exhaustive over the 14 known RUN_TYPE_* values (0-13); the trailing
   * `unreachable()` converts an unrecognized type — a table-generation
   * or port bug — into a loud trap instead of C's silent `default:`
   * identity (the "exhaustive dispatch over bare-else" lesson). */
  private caseConvEntry(): number {
    return this.cached("caseConvEntry", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([I32, I32, I32], [I32, I32, I32, I32]),
        "%w.str.caseConvEntry",
      );
      const c = new Code();
      const CP = 0,
        CONV = 1,
        IDX = 2,
        V = 3,
        CODE = 4,
        TYPE = 5,
        DATA = 6,
        A = 7;

      const tbl1 = (pushIdx: () => void): void => {
        c.globalGet(this.gTable1);
        pushIdx();
        c.arrayGet(this.table1Type);
      };
      const extAt = (pushIdx: () => void): void => {
        c.globalGet(this.gExt);
        pushIdx();
        c.arrayGetU(this.extType);
      };
      const retOne = (pushR0: () => void): void => {
        c.i32Const(1);
        pushR0();
        c.i32Const(0);
        c.i32Const(0);
        c.return_();
      };
      const retTwo = (pushR0: () => void, pushR1: () => void): void => {
        c.i32Const(2);
        pushR0();
        pushR1();
        c.i32Const(0);
        c.return_();
      };
      const retThree = (pushR0: () => void, pushR1: () => void, pushR2: () => void): void => {
        c.i32Const(3);
        pushR0();
        pushR1();
        pushR2();
        c.return_();
      };
      const retIdentity = (): void => retOne(() => c.localGet(CP));

      c.call(this.ensureInit());
      c.globalGet(this.gTable1);
      c.localGet(IDX);
      c.arrayGet(this.table1Type);
      c.localSet(V);
      c.localGet(V);
      c.i32Const(15);
      c.i32ShrU();
      c.localSet(CODE);
      c.localGet(V);
      c.i32Const(4);
      c.i32ShrU();
      c.i32Const(0xf);
      c.i32And();
      c.localSet(TYPE);
      c.localGet(V);
      c.i32Const(0xf);
      c.i32And();
      c.i32Const(8);
      c.i32Shl();
      c.globalGet(this.gTable2);
      c.localGet(IDX);
      c.arrayGetU(this.i8ArrType);
      c.i32Or();
      c.localSet(DATA);

      // types 0-3: RUN_TYPE_U/L/UF/LF — shared formula, direction-gated
      // by `convType == (type & 1)` (the `|| conv_type == 2` disjunct
      // dropped, dead per the header).
      c.localGet(TYPE);
      c.i32Const(4);
      c.i32LtU();
      c.ifVoid();
      c.localGet(CONV);
      c.localGet(TYPE);
      c.i32Const(1);
      c.i32And();
      c.i32Eq();
      c.ifVoid();
      retOne(() => {
        c.localGet(CP);
        c.localGet(CODE);
        c.i32Sub();
        tbl1(() => c.localGet(DATA));
        c.i32Const(15);
        c.i32ShrU();
        c.i32Add();
      });
      c.end();
      retIdentity();
      c.end();

      // type 4: RUN_TYPE_UL — parity swap. The C BREAKS to identity when
      // `(a&1) != (1-is_lower)` — so it PROCEEDS (computes the swap)
      // exactly when that comparison is FALSE, i.e. `(a&1) ==
      // (1-is_lower)`. is_lower == convType for convType ∈ {0,1}, and
      // `(a&1) == (1-convType)` over single bits is `(a&1) != convType`
      // (caught by the exhaustive mapping sweep at U+0100: the first
      // version of this arm inverted proceed/break and silently swapped
      // every UL-range pair's direction).
      c.localGet(TYPE);
      c.i32Const(4);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CP);
      c.localGet(CODE);
      c.i32Sub();
      c.localSet(A);
      c.localGet(A);
      c.i32Const(1);
      c.i32And();
      c.localGet(CONV);
      c.i32Ne();
      c.ifVoid();
      retOne(() => {
        c.localGet(A);
        c.i32Const(1);
        c.i32Xor();
        c.localGet(CODE);
        c.i32Add();
      });
      c.end();
      retIdentity();
      c.end();

      // type 5: RUN_TYPE_LSU. is_lower == convType for convType ∈ {0,1},
      // so `2*is_lower-1` = `2*convType-1` and `(1-is_lower)*2` =
      // `(1-convType)*2`.
      c.localGet(TYPE);
      c.i32Const(5);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CP);
      c.localGet(CODE);
      c.i32Sub();
      c.localSet(A);
      c.localGet(A);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      retOne(() => {
        c.localGet(CP);
        c.localGet(CONV);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(1);
        c.i32Sub();
        c.i32Add();
      });
      c.end();
      c.localGet(A);
      c.i32Const(1);
      c.localGet(CONV);
      c.i32Sub();
      c.i32Const(2);
      c.i32Mul();
      c.i32Eq();
      c.ifVoid();
      retOne(() => {
        c.localGet(CP);
        c.localGet(CONV);
        c.i32Const(2);
        c.i32Mul();
        c.i32Const(1);
        c.i32Sub();
        c.i32Const(2);
        c.i32Mul();
        c.i32Add();
      });
      c.end();
      retIdentity();
      c.end();

      // type 6: RUN_TYPE_U2L_399_EXT2 — the Greek iota-subscript family.
      // Both directions always produce a result (no identity fallback,
      // matching the C: this arm never falls through to `break`).
      c.localGet(TYPE);
      c.i32Const(6);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Eqz();
      c.ifVoid();
      retTwo(
        () => {
          c.localGet(CP);
          c.localGet(CODE);
          c.i32Sub();
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(6);
            c.i32ShrU();
          });
          c.i32Add();
        },
        () => c.i32Const(0x399),
      );
      c.end();
      retOne(() => {
        c.localGet(CP);
        c.localGet(CODE);
        c.i32Sub();
        extAt(() => {
          c.localGet(DATA);
          c.i32Const(0x3f);
          c.i32And();
        });
        c.i32Add();
      });
      c.end();

      // type 7: RUN_TYPE_UF_D20 — upper-only (dead `+convType==2` offset
      // dropped, so this is pure identity-to-data).
      c.localGet(TYPE);
      c.i32Const(7);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      retIdentity();
      c.end();
      retOne(() => c.localGet(DATA));
      c.end();

      // type 8: RUN_TYPE_UF_D1_EXT — upper-only single ext lookup.
      c.localGet(TYPE);
      c.i32Const(8);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      retIdentity();
      c.end();
      retOne(() => extAt(() => c.localGet(DATA)));
      c.end();

      // types 9/10: RUN_TYPE_U_EXT / RUN_TYPE_LF_EXT — direction-gated
      // single ext lookup. `type==9 || type==10` here is a SAFE i32.or
      // (both operands are pure TYPE comparisons, no memory access).
      c.localGet(TYPE);
      c.i32Const(9);
      c.i32Eq();
      c.localGet(TYPE);
      c.i32Const(10);
      c.i32Eq();
      c.i32Or();
      c.ifVoid();
      c.localGet(CONV);
      c.localGet(TYPE);
      c.i32Const(9);
      c.i32Sub();
      c.i32Eq();
      c.ifVoid();
      retOne(() => extAt(() => c.localGet(DATA)));
      c.end();
      retIdentity();
      c.end();

      // type 12: RUN_TYPE_LF_EXT2 — lower-only, 2-result.
      c.localGet(TYPE);
      c.i32Const(12);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Eqz();
      c.ifVoid();
      retIdentity();
      c.end();
      retTwo(
        () => {
          c.localGet(CP);
          c.localGet(CODE);
          c.i32Sub();
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(6);
            c.i32ShrU();
          });
          c.i32Add();
        },
        () =>
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(0x3f);
            c.i32And();
          }),
      );
      c.end();

      // type 11: RUN_TYPE_UF_EXT2 — upper-only (dead fold-refold
      // sub-branch dropped), 2-result.
      c.localGet(TYPE);
      c.i32Const(11);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      retIdentity();
      c.end();
      retTwo(
        () => {
          c.localGet(CP);
          c.localGet(CODE);
          c.i32Sub();
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(6);
            c.i32ShrU();
          });
          c.i32Add();
        },
        () =>
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(0x3f);
            c.i32And();
          }),
      );
      c.end();

      // type 13: RUN_TYPE_UF_EXT3 — upper-only, 3-result. The one arm
      // measured to need the worst-case growth (U+0390 -> 3 units).
      c.localGet(TYPE);
      c.i32Const(13);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      retIdentity();
      c.end();
      retThree(
        () =>
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(8);
            c.i32ShrU();
          }),
        () =>
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(4);
            c.i32ShrU();
            c.i32Const(0xf);
            c.i32And();
          }),
        () =>
          extAt(() => {
            c.localGet(DATA);
            c.i32Const(0xf);
            c.i32And();
          }),
      );
      c.end();

      c.unreachable(); // exhaustiveness trap — see header note.
      this.mb.setBody(idx, [I32, I32, I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseConvCp(cp, convType) → (count, r0, r1, r2) — the
   * per-code-point entry point (findCaseRange miss = identity, hit =
   * caseConvEntry). Exposed as its own function so the exhaustive
   * mapping sweep (rev-inc20's pin #1) can drive it directly, one code
   * point at a time, without building a fresh one-character string per
   * iteration. */
  caseConvCp(): number {
    return this.cached("caseConvCp", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([I32, I32], [I32, I32, I32, I32]),
        "%w.str.caseConvCp",
      );
      const c = new Code();
      const CP = 0,
        CONV = 1,
        IDX = 2;
      c.localGet(CP);
      c.call(this.findCaseRange());
      c.localSet(IDX);
      c.localGet(IDX);
      c.i32Const(-1);
      c.i32Eq();
      c.ifVoid();
      c.i32Const(1);
      c.localGet(CP);
      c.i32Const(0);
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(CP);
      c.localGet(CONV);
      c.localGet(IDX);
      c.call(this.caseConvEntry());
      this.mb.setBody(idx, [I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseDecodeFwd(s, i) → (cp, adv) — string_getc's shape
   * (quickjs.c:4516): decode the code point starting at `i`, surrogate-
   * pair-aware. The "is there a low-surrogate partner" check is REAL
   * nested control flow (the `i+1 < len` guard is a genuine `if`, not an
   * i32.and operand) — the array read at i+1 is only valid once that
   * guard holds. Falls through to identity/adv=1 by default (covers lone
   * surrogates automatically, no special-casing — S002; verified against
   * Node: identity both directions, all 2048 surrogate-range values). */
  private decodeFwd(): number {
    return this.cached("decodeFwd", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), I32], [I32, I32]),
        "%w.str.caseDecodeFwd",
      );
      const c = new Code();
      const S = 0,
        I = 1,
        U = 2,
        U2 = 3;
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.strType);
      c.localSet(U);

      // high surrogate range check — pure scalar compares on U, SAFE and.
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(U);
      c.i32Const(0xdbff);
      c.i32LeU();
      c.i32And();
      c.ifVoid();
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localGet(S);
      c.arrayLen();
      c.i32LtS();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.arrayGetU(this.strType);
      c.localSet(U2);
      c.localGet(U2);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(U2);
      c.i32Const(0xdfff);
      c.i32LeU();
      c.i32And();
      c.ifVoid();
      c.i32Const(0x10000);
      c.localGet(U);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(10);
      c.i32Shl();
      c.i32Add();
      c.localGet(U2);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.i32Const(2);
      c.return_();
      c.end();
      c.end();
      c.end();

      c.localGet(U);
      c.i32Const(1);
      this.mb.setBody(idx, [I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseDecodeBack(s, k) → (cp, newK) — string_prevc's shape,
   * bounded to a 2-unit lookback (simpler than the C lane's open-ended
   * UTF-8 continuation scan). Precondition: k >= 1 (every caller, exactly
   * like the C reference, checks k > 0 BEFORE calling — matches
   * scr_case_prev's own contract, no redundant internal guard). */
  private decodeBack(): number {
    return this.cached("decodeBack", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), I32], [I32, I32]),
        "%w.str.caseDecodeBack",
      );
      const c = new Code();
      const S = 0,
        K = 1,
        U = 2,
        U2 = 3;

      c.localGet(K);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid();
      c.localGet(S);
      c.localGet(K);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(U); // s[k-1]
      c.localGet(U);
      c.i32Const(0xdc00);
      c.i32GeU();
      c.localGet(U);
      c.i32Const(0xdfff);
      c.i32LeU();
      c.i32And();
      c.ifVoid();
      c.localGet(S);
      c.localGet(K);
      c.i32Const(2);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(U2); // s[k-2]
      c.localGet(U2);
      c.i32Const(0xd800);
      c.i32GeU();
      c.localGet(U2);
      c.i32Const(0xdbff);
      c.i32LeU();
      c.i32And();
      c.ifVoid();
      c.i32Const(0x10000);
      c.localGet(U2);
      c.i32Const(0xd800);
      c.i32Sub();
      c.i32Const(10);
      c.i32Shl();
      c.i32Add();
      c.localGet(U);
      c.i32Const(0xdc00);
      c.i32Sub();
      c.i32Add();
      c.localGet(K);
      c.i32Const(2);
      c.i32Sub();
      c.return_();
      c.end();
      c.end();
      c.end();

      c.localGet(S);
      c.localGet(K);
      c.i32Const(1);
      c.i32Sub();
      c.arrayGetU(this.strType);
      c.localSet(U);
      c.localGet(U);
      c.localGet(K);
      c.i32Const(1);
      c.i32Sub();
      this.mb.setBody(idx, [I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.finalSigma(s, sigmaOff, nextOff) → i32 bool —
   * scr_final_sigma/test_final_sigma's back/forward scans, ported to
   * UTF-16 code-unit stepping via decodeBack/decodeFwd. Pair-aware
   * stepping in BOTH scans is load-bearing (rev-inc20's astral
   * discriminating pins: a naive one-unit step at a lone-surrogate-half
   * read gives the WRONG verdict, in both directions).
   *
   * DESIGN ADDENDUM v2.1 (rev-inc20): the back-scan's `k == 0 -> return
   * false` guard runs BEFORE every call to decodeBack, never after —
   * this is deliberate and must not be simplified into "just call
   * decodeBack and check what it returns at the boundary". quickjs's own
   * string_prevc returns 0 (the code point value, not a sentinel) when
   * idx <= 0, which is INDISTINGUISHABLE from a real U+0000 in the
   * input. That collision is harmless today only by table accident
   * (U+0000 is neither Cased nor Case_Ignorable, so treating a spurious
   * 0 as "a real NUL, not ignorable, not cased" happens to short-circuit
   * the scan the same way an explicit k==0 check would) — but it is
   * UNPINNABLE: no corpus program or pin in this suite can tell a
   * correct guard-before-step port apart from one that dropped the
   * guard and relied on the accident, because both produce identical
   * output on every input this decoder can construct. The guard exists
   * so correctness doesn't depend on that accident holding. */
  private finalSigma(): number {
    return this.cached("finalSigma", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), I32, I32], [I32]),
        "%w.str.finalSigma",
      );
      const c = new Code();
      const S = 0,
        SIGMA_OFF = 1,
        NEXT_OFF = 2,
        K = 3,
        CP = 4,
        ADV = 5;
      const decodeBack = this.decodeBack();
      const decodeFwd = this.decodeFwd();
      const isCaseIgnorable = this.isCaseIgnorable();
      const isCased = this.isCased();

      // back-scan: skip case-ignorable, require a cased char before Σ.
      // Guard BEFORE step, deliberately — see the NUL-collision note on
      // this function's doc comment; never rewrite this to "step then
      // check what decodeBack returned".
      c.localGet(SIGMA_OFF);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      c.localGet(S);
      c.localGet(K);
      c.call(decodeBack);
      c.localSet(K); // top = newK
      c.localSet(CP); // next = cp
      c.localGet(CP);
      c.call(isCaseIgnorable);
      c.i32Eqz();
      c.brIf(1); // not ignorable -> stop scanning
      c.br(0);
      c.end();
      c.end();
      c.localGet(CP);
      c.call(isCased);
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();

      // forward-scan: skip case-ignorable, require NO cased char after.
      c.localGet(NEXT_OFF);
      c.localSet(K);
      c.block();
      c.loop();
      c.localGet(K);
      c.localGet(S);
      c.arrayLen();
      c.i32GeS();
      c.ifVoid();
      c.i32Const(1);
      c.return_();
      c.end();
      c.localGet(S);
      c.localGet(K);
      c.call(decodeFwd);
      c.localSet(ADV); // top = adv
      c.localSet(CP); // next = cp
      c.localGet(K);
      c.localGet(ADV);
      c.i32Add();
      c.localSet(K);
      c.localGet(CP);
      c.call(isCaseIgnorable);
      c.i32Eqz();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      c.localGet(CP);
      c.call(isCased);
      c.i32Eqz();
      this.mb.setBody(idx, [I32, I32, I32], c.bytes());
      return idx;
    });
  }

  /** %w.str.caseConv(s, convType) → str — the full walk: decode forward,
   * Final_Sigma special-case on Σ+lower, else caseConvCp; write 1-3
   * result code points (re-encoding astral results as surrogate pairs)
   * into a scratch buffer sized 3*inputUnits (measured exact bound —
   * shrink never observed, max growth +2 units at U+0390, over all
   * 1,114,112 code points both directions), then trim to the exact used
   * length (json.ts's jstring() over/under-allocate-then-trim idiom).
   * The `3 * len` overflow guard mirrors repeat()'s f64 pre-check
   * (strings.ts:638-646) — S003-bridge trap, not a silent wraparound. */
  private caseConvWorker(): number {
    return this.cached("caseConv", () => {
      const idx = this.mb.declareFunc(
        this.mb.funcType([this.strRef(), I32], [this.strRef()]),
        "%w.str.caseConv",
      );
      const c = new Code();
      const S = 0,
        CONV = 1,
        L = 2,
        OUT = 3,
        N = 4,
        I = 5,
        CP = 6,
        ADV = 7,
        IS_SIGMA_LOWER = 8,
        CNT = 9,
        R0 = 10,
        R1 = 11,
        R2 = 12,
        TMPCP = 13,
        R = 14;
      const decodeFwd = this.decodeFwd();
      const finalSigma = this.finalSigma();
      const caseConvCp = this.caseConvCp();

      const emitWriteCp = (pushCp: () => void): void => {
        pushCp();
        c.localSet(TMPCP);
        c.localGet(TMPCP);
        c.i32Const(0x10000);
        c.i32LtU();
        c.ifVoid();
        c.localGet(OUT);
        c.localGet(N);
        c.localGet(TMPCP);
        c.arraySet(this.strType);
        c.localGet(N);
        c.i32Const(1);
        c.i32Add();
        c.localSet(N);
        c.else_();
        c.localGet(OUT);
        c.localGet(N);
        c.i32Const(0xd800);
        c.localGet(TMPCP);
        c.i32Const(0x10000);
        c.i32Sub();
        c.i32Const(10);
        c.i32ShrU();
        c.i32Add();
        c.arraySet(this.strType);
        c.localGet(OUT);
        c.localGet(N);
        c.i32Const(1);
        c.i32Add();
        c.i32Const(0xdc00);
        c.localGet(TMPCP);
        c.i32Const(0x10000);
        c.i32Sub();
        c.i32Const(0x3ff);
        c.i32And();
        c.i32Add();
        c.arraySet(this.strType);
        c.localGet(N);
        c.i32Const(2);
        c.i32Add();
        c.localSet(N);
        c.end();
      };

      c.localGet(S);
      c.arrayLen();
      c.localSet(L);

      // scratch-size overflow guard (repeat()'s f64 pre-check precedent).
      c.localGet(L);
      c.f64ConvertI32S();
      c.f64Const(3);
      c.f64Mul();
      c.f64Const(2147483648);
      c.f64Ge();
      c.ifVoid();
      c.unreachable();
      c.end();

      c.localGet(L);
      c.i32Const(3);
      c.i32Mul();
      c.arrayNewDefault(this.strType);
      c.localSet(OUT);
      c.i32Const(0);
      c.localSet(N);
      c.i32Const(0);
      c.localSet(I);

      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(L);
      c.i32GeS();
      c.brIf(1);

      c.localGet(S);
      c.localGet(I);
      c.call(decodeFwd);
      c.localSet(ADV); // top = adv
      c.localSet(CP); // next = cp

      c.i32Const(0);
      c.localSet(IS_SIGMA_LOWER);
      c.localGet(CP);
      c.i32Const(0x3a3);
      c.i32Eq();
      c.ifVoid();
      c.localGet(CONV);
      c.i32Const(1);
      c.i32Eq();
      c.ifVoid();
      c.localGet(S);
      c.localGet(I);
      c.localGet(I);
      c.localGet(ADV);
      c.i32Add();
      c.call(finalSigma);
      c.ifVoid();
      c.i32Const(1);
      c.localSet(IS_SIGMA_LOWER);
      c.end();
      c.end();
      c.end();

      c.localGet(IS_SIGMA_LOWER);
      c.ifVoid();
      c.i32Const(1);
      c.localSet(CNT);
      c.i32Const(0x3c2);
      c.localSet(R0);
      c.else_();
      c.localGet(CP);
      c.localGet(CONV);
      c.call(caseConvCp);
      c.localSet(R2);
      c.localSet(R1);
      c.localSet(R0);
      c.localSet(CNT);
      c.end();

      emitWriteCp(() => c.localGet(R0));
      c.localGet(CNT);
      c.i32Const(2);
      c.i32GeS();
      c.ifVoid();
      emitWriteCp(() => c.localGet(R1));
      c.end();
      c.localGet(CNT);
      c.i32Const(3);
      c.i32GeS();
      c.ifVoid();
      emitWriteCp(() => c.localGet(R2));
      c.end();

      c.localGet(I);
      c.localGet(ADV);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();

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
      this.mb.setBody(
        idx,
        [I32, this.strRef(), I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, this.strRef()],
        c.bytes(),
      );
      return idx;
    });
  }

  /** %w.str.toLower — (s) → str, convType=1. Thin wrapper over the
   * shared worker (matches scr_str_to_lower/scr_str_to_upper's own shape:
   * two trivial wrappers around one shared conv routine). */
  toLowerCase(): number {
    return this.cached("toLower", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.strRef()]), "%w.str.toLower");
      const c = new Code();
      c.localGet(0);
      c.i32Const(1);
      c.call(this.caseConvWorker());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }

  /** %w.str.toUpper — (s) → str, convType=0. */
  toUpperCase(): number {
    return this.cached("toUpper", () => {
      const idx = this.mb.declareFunc(this.mb.funcType([this.strRef()], [this.strRef()]), "%w.str.toUpper");
      const c = new Code();
      c.localGet(0);
      c.i32Const(0);
      c.call(this.caseConvWorker());
      this.mb.setBody(idx, [], c.bytes());
      return idx;
    });
  }
}
