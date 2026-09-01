/* INC-24 P1, CP4: regex-interpreter.ts's FOUNDATIONAL pieces (getChar,
 * ensureStackSpace, newCaptureArray, readU8/readU16/readU32) — tested
 * standalone, BEFORE the much larger and riskier main dispatch loop
 * (br_table switch + all opcode handlers) is built on top of them.
 * Building this pin file surfaced a genuinely broken first draft of
 * getChar (a tangle of nested ifResult expressions whose own trailing
 * comment contradicted what it actually pushed) — thrown away and
 * rewritten as a linear default-then-conditionally-override sequence
 * BEFORE ever being tested, precisely because hand-written wasm bytecode
 * is exactly the kind of thing that looks plausible and is wrong; these
 * pins are what actually catch that class of mistake, not code review
 * of the emission calls alone. Idiom throughout: wasm-casing.test.ts's
 * own Stage-A pattern (ModuleBuilder + a builder class + exportFunc +
 * WebAssembly.instantiate(bytes, {}), no host imports needed). */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";

interface CoreExports {
  lit: (i: number) => unknown;
  getChar: (subject: unknown, idx: number, isUnicode: number) => [number, number];
  peekChar: (subject: unknown, idx: number, isUnicode: number) => number;
  peekPrevChar: (subject: unknown, idx: number, isUnicode: number) => number;
  prevChar: (subject: unknown, idx: number, isUnicode: number) => number;
  ensureStackSpace: (stack: unknown, sp: number, needed: number) => unknown;
  newCaptureArray: (count: number) => unknown;
  readU8: (bc: unknown, pos: number) => number;
  readU16: (bc: unknown, pos: number) => number;
  readU32: (bc: unknown, pos: number) => number;
  arrLen: (arr: unknown) => number;
  capAt: (arr: unknown, i: number) => number;
  capSet: (arr: unknown, i: number, v: number) => void;
  bcLit: (i: number) => unknown;
  testDispatchLoop: (bc: unknown) => number;
  noMatch: (stack: unknown, sp: number, bp: number, captureOut: unknown, compareType: number, continueOnEqual: number) => [number, number, number, number, number];
  stackLit: (i: number) => unknown;
  rangeSearch: (table: unknown, pos: number, n: number, is32: number, c: number) => number;
  saveCaptureCheck: (stack: unknown, sp: number, bp: number, captureOut: unknown, idx: number, value: number) => [unknown, number];
  lookaheadMatch: (stack: unknown, sp: number, bp: number) => [unknown, number, number, number, number];
  backRefCompare: (
    subject: unknown,
    cptr: number,
    capStart: number,
    capEnd: number,
    isUnicode: number,
    isBackward: number,
    ignoreCase: number,
  ) => [number, number];
}

// Synthetic backtrack stacks for noMatch, built via arrayNewFixed with
// LITERAL i32 values — each entry is 4 slots (pc, cptr, bp, type), this
// port's own unpacked equivalent of C's 3-slot {ptr, ptr, bp-bitfield}
// (see regex-interpreter.ts's own header, translation 3). SPLIT=0,
// LOOKAHEAD=1.
const STACK_LITERALS: Record<string, number[]> = {
  // One SPLIT entry at bp=0: pc=100, cptr=5, bp=0, type=SPLIT(0).
  oneSplitFromBase: [100, 5, 0, 0],
  // Two SPLIT entries chained: the second (pushed later, at the END of
  // the array — sp starts at the array's own length) has bp=4 (pointing
  // BACK at the first entry's own base), so popping it once restores
  // bp=4, NOT bp=0 — a SECOND no_match call would be needed to reach
  // bp==0 (exercised as two SEPARATE calls in the test below, not one).
  // Entry 1 (offset 0-3): pc=100,cptr=5,bp=0,type=SPLIT. Entry 2
  // (offset 4-7): pc=200,cptr=8,bp=4,type=SPLIT.
  twoSplitsChained: [100, 5, 0, 0, 200, 8, 4, 0],
  // A SPLIT entry BELOW a LOOKAHEAD entry: popping the LOOKAHEAD first
  // (type=1) must CONTINUE unwinding WITHIN ONE no_match CALL (skip
  // over it) and land on the SPLIT beneath — proves the outer loop's
  // own "continue while LOOKAHEAD" logic actually fires, not just the
  // single-pop path oneSplitFromBase/twoSplitsChained exercise. Entry 1
  // (offset 0-3): pc=100,cptr=5,bp=0,type=SPLIT. Entry 2 (offset 4-7):
  // pc=250,cptr=9,bp=4,type=LOOKAHEAD.
  lookaheadAboveSplit: [100, 5, 0, 0, 250, 9, 4, 1],
  // A SPLIT backtrack-point entry (offset 0-3) with a 2-slot CAPTURE-
  // SAVE entry pushed ON TOP of it (offset 4-5: capture index 1, the
  // OLD value -1 SAVE_CAPTURE would have pushed BEFORE overwriting
  // captureOut[1] with something new) — sp=6, bp stays 4 (SAVE_CAPTURE
  // never touches bp, only a backtrack point like split does). Verifies
  // the "undo capture modifications" step actually restores captureOut
  // on pop, not just the pc/cptr/bp/sp bookkeeping the other fixtures
  // already cover.
  splitWithCaptureSaveOnTop: [100, 5, 0, 0, 1, -1],
  // saveCaptureCheck fixtures — plain 2-slot capture-save-shaped
  // entries (idx, oldValue), same shape SAVE_CAPTURE/SAVE_CAPTURE_CHECK
  // both push.
  saveCheckTwoEntries: [3, 10, 5, 20], // entry0=(idx=3,old=10) at [0,1]; entry1=(idx=5,old=20) at [2,3]
  saveCheckScanPastOne: [8, 111, 5, 222], // entry0=(idx=8,old=111) at [0,1]; entry1=(idx=5,old=222) at [2,3] — searching idx=8 must scan PAST entry1 first
  // lookaheadMatch fixtures. NEGATIVE_LOOKAHEAD=2.
  // A single LOOKAHEAD marker, nothing else: [0,4) = pc=500,cptr=7,
  // bpVal=0,type=1.
  lookaheadAlone: [500, 7, 0, 1],
  // findings-p1-v1.txt's own hand-traced example, transcribed as a
  // fixture almost verbatim (rescaled to start at 0): LOOKAHEAD marker
  // at [0,4)=pc=500,cptr=7,bpVal=0,type=1; capSave1 at [4,6)=idx=3,
  // old=99; SPLIT marker at [6,10)=pc=600,cptr=8,bpVal=4,type=0;
  // capSave2 at [10,12)=idx=5,old=88; capSave3 at [12,14)=idx=9,old=77.
  // sp=14, bp=10 (the split's own recorded "sp right after it pushed").
  lookaheadWithInterveningSplit: [500, 7, 0, 1, 3, 99, 600, 8, 4, 0, 5, 88, 9, 77],
  // Two LOOKAHEAD-type markers stacked, marker A (far, at the bottom,
  // pc=100) and marker B (near, at the top, pc=200) — a synthetic
  // shape (a genuinely LIVE second lookahead marker never survives
  // this deep in a real compiled program, per lookaheadMatch's own
  // doc comment on why), but a VALID stack shape the algorithm's own
  // stop-condition must still get right: it should stop at the FIRST
  // (nearest) LOOKAHEAD marker it meets, never walking PAST it looking
  // for some OTHER one. sp=bp=8.
  lookaheadTwoStacked: [100, 10, 0, 1, 200, 20, 0, 1],
  // A LOOKAHEAD marker directly followed by a SPLIT marker with ZERO
  // capture-saves in EITHER segment (nothing above the split, nothing
  // between the split and the lookahead) — every array.copy this walk
  // performs is a genuine zero-length no-op, proving that's harmless
  // rather than assumed. sp=bp=8.
  lookaheadZeroSavesBothSegments: [500, 7, 0, 1, 600, 8, 4, 0],
  // A capture-save entry BELOW the LOOKAHEAD marker's own position
  // (idx=99,old=88 — representing an OUTER capture from before the
  // lookahead started) plus one ABOVE it (idx=3,old=77 — from inside
  // the body) — proves the compaction touches ONLY [bp,sp), never
  // reaching below the marker chain it's walking to corrupt an
  // outer capture-save that isn't this call's concern at all. sp=8,
  // bp=6 (the marker sits at [2,6), so bp points just past it).
  lookaheadSavesBelowMarker: [99, 88, 400, 40, 0, 1, 3, 77],
  // A NEGATIVE_LOOKAHEAD-type marker sitting ABOVE the LOOKAHEAD target
  // — "by construction, only THIS lookahead's own marker is ever found"
  // covers ASSEMBLED bytecode, not what the loop's own mechanism does
  // if it met a marker type it doesn't specifically look for (this
  // port's OWN established precedent for unreachable-by-construction
  // shapes — char32_i, REOP_prev — is to hand-build a fixture proving
  // the mechanism directly, not to leave the claim unverified). Proves
  // the walk treats an UNEXPECTED type (here NEGATIVE_LOOKAHEAD) the
  // SAME as any other non-target type (SPLIT already covers this,
  // separately) — continues past it, does not stop, does not trap.
  // LOOKAHEAD marker (target) at [0,4)=pc=500,cptr=7,bpVal=0,type=1;
  // NEGATIVE_LOOKAHEAD marker at [4,8)=pc=999,cptr=99,bpVal=4,type=2
  // (bpVal=4 correctly chains back to the target marker's own
  // position — the SAME convention lookaheadAboveSplit's own second
  // entry, and this file's other multi-marker fixtures, already use;
  // getting this wrong here the FIRST time produced exactly the same
  // out-of-bounds trap the earlier negLookaheadAboveLookahead fixture
  // mistake did, for the identical reason).
  lookaheadSkipsUnexpectedType: [500, 7, 0, 1, 999, 99, 4, 2],
  // noMatch(stopType=NEGATIVE_LOOKAHEAD) fixtures.
  // A single NEGATIVE_LOOKAHEAD marker, nothing else: [0,4) = pc=700,
  // cptr=11, bpVal=0, type=2.
  negLookaheadAlone: [700, 11, 0, 2],
  // NEGATIVE_LOOKAHEAD marker at [0,4)=pc=700,cptr=11,bpVal=0,type=2;
  // capSave at [4,6)=idx=2,old=-1 (must get UNDONE — negative lookahead
  // undoes captures normally, unlike lookaheadMatch); SPLIT marker at
  // [6,10)=pc=800,cptr=12,bpVal=4,type=0 (must be SKIPPED, not mistaken
  // for the target). sp=bp=10.
  negLookaheadWithInterveningSplit: [700, 11, 0, 2, 2, -1, 800, 12, 4, 0],
  // NEGATIVE_LOOKAHEAD marker at [0,4)=pc=700,cptr=11,bpVal=0,type=2;
  // a LOOKAHEAD marker at [4,8)=pc=900,cptr=13,bpVal=4,type=1 sitting
  // ABOVE it (bpVal=4 correctly chains back to the first marker's own
  // position — the SAME convention lookaheadAboveSplit's own second
  // entry already established) — proves the walk does NOT stop at a
  // LOOKAHEAD-type marker either (discriminating against a bug that
  // stops at "any non-SPLIT" rather than specifically NEGATIVE_
  // LOOKAHEAD). sp=bp=8.
  negLookaheadAboveLookahead: [700, 11, 0, 2, 900, 13, 4, 1],
};
const STACK_KEYS = Object.keys(STACK_LITERALS);

// A small set of UTF-16 literals covering: ASCII, a real astral pair
// (surrogate combination should fire), and a LONE surrogate at the very
// end (combination must NOT fire — there's no following low surrogate
// to pair with).
const LITERALS: Record<string, string> = {
  ascii: "ab",
  astral: "\u{1F600}", // 😀 — one astral code point, encoded as a real surrogate pair
  loneHighAtEnd: "a\ud83d", // a high surrogate with NOTHING after it
  loneLowFirst: "\ude00a", // a low surrogate with nothing valid BEFORE it (not a hi surrogate before it)
  charThenLoneLow: "a\ude00", // a low surrogate whose PRECEDING code unit exists but is NOT a high surrogate
  // backRefCompare fixtures.
  abcabc: "abcabc", // forward AND backward match: "abc" repeated
  abcabd: "abcabd", // forward mismatch at the LAST character (c vs d)
  abca: "abca", // forward exhaustion: only 1 char available after cptr=... (length 4)
  xyzxwz: "xyzxwz", // backward mismatch: matches on the first (rightmost) char, mismatches on the second
  abcABC: "abcABC", // ignoreCase forward: lowercase capture vs uppercase subject
};
const LIT_KEYS = Object.keys(LITERALS);

// u16/u32 (low,high) PAIR encoders for rangeSearch's own fixture
// tables — computed, not hand-typed hex, so a fixture's actual VALUES
// stay the reviewable source of truth rather than their little-endian
// byte encoding (the same reasoning RegexByteWriter's own u16/u32
// methods exist for, applied here to test data instead of production
// bytecode).
function u16Pairs(pairs: readonly (readonly [number, number])[]): number[] {
  return pairs.flatMap(([lo, hi]) => [lo & 0xff, (lo >> 8) & 0xff, hi & 0xff, (hi >> 8) & 0xff]);
}
function u32Pairs(pairs: readonly (readonly [number, number])[]): number[] {
  return pairs.flatMap(([lo, hi]) => [
    lo & 0xff,
    (lo >>> 8) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 24) & 0xff,
    hi & 0xff,
    (hi >>> 8) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 24) & 0xff,
  ]);
}

// Bytecode-shaped test blobs for readU8/readU16/readU32 — arbitrary
// bytes, not real regex bytecode (these three functions are pure
// little-endian reads, independent of the bytecode's actual meaning).
const BC_LITERALS: Record<string, number[]> = {
  simple: [0x12, 0x34, 0x56, 0x78, 0x9a],
  allFF: [0xff, 0xff, 0xff, 0xff],
  // testDispatchLoop sequences: 0/1/2 add 10/20/30, 255 terminates.
  case0: [0, 255],
  case1: [1, 255],
  case2: [2, 255],
  allThree: [0, 1, 2, 255],
  repeatedCase1: [1, 1, 1, 255],
  terminatorFirst: [255],
  reversedOrder: [2, 1, 0, 255],
  // rangeSearch fixtures (raw sorted (low,high) pairs, no opcode/len
  // prefix — matching what buildFixedRangeTable strips off, and what
  // emitRangeTest's own TABLE_POS points at inside real bytecode).
  rangeSingle16: u16Pairs([[10, 20]]),
  rangeMulti16: u16Pairs([
    [10, 20],
    [30, 40],
    [50, 60],
  ]),
  // Last pair's high is the 16-bit form's "+infinity" sentinel
  // (0xffff) — an astral `c` (only representable once a surrogate
  // pair combines, so genuinely > 0xffff) must match via this special
  // case; WITHOUT it, plain c>high comparison would wrongly reject it.
  rangeInfinity16: u16Pairs([
    [10, 20],
    [100, 0xffff],
  ]),
  range32Single: u32Pairs([[0x10000, 0x10ffff]]),
  range32Multi: u32Pairs([
    [0x10000, 0x103ff],
    [0x20000, 0x2fffd],
  ]),
  // 4 arbitrary padding bytes followed by rangeSingle16's own table —
  // a genuine non-zero `pos` fixture (TABLE_POS in real bytecode is
  // never 0: it always sits after at least the opcode + u16 n field).
  rangeSingle16Padded: [0xaa, 0xbb, 0xcc, 0xdd, ...u16Pairs([[10, 20]])],
};
const BC_KEYS = Object.keys(BC_LITERALS);

async function build(): Promise<CoreExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const capType = mb.arrayType(I32, true);
  const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
  const interp = new RegexInterpreterBuilder(mb, strType);

  const litUnits = (s: string): Uint8Array => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    return units;
  };

  const litFn = mb.declareFunc(mb.funcType([I32], [strRef]), "lit");
  {
    const c = new Code();
    LIT_KEYS.forEach((key, i) => {
      const s = LITERALS[key]!;
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const off = mb.internData(litUnits(s));
      c.i32Const(off);
      c.i32Const(s.length);
      c.arrayNewData(strType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(litFn, [], c.bytes());
  }

  const bcLitFn = mb.declareFunc(mb.funcType([I32], [bcRef]), "bcLit");
  {
    const c = new Code();
    BC_KEYS.forEach((key, i) => {
      const bytes = BC_LITERALS[key]!;
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const off = mb.internData(new Uint8Array(bytes));
      c.i32Const(off);
      c.i32Const(bytes.length);
      c.arrayNewData(bcType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(bcLitFn, [], c.bytes());
  }

  const stackLitFn = mb.declareFunc(mb.funcType([I32], [capRef]), "stackLit");
  {
    const c = new Code();
    STACK_KEYS.forEach((key, i) => {
      const values = STACK_LITERALS[key]!;
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      for (const v of values) c.i32Const(v);
      c.arrayNewFixed(capType, values.length);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(stackLitFn, [], c.bytes());
  }

  const arrLenFn = mb.declareFunc(mb.funcType([capRef], [I32]), "arrLen");
  {
    const c = new Code();
    c.localGet(0);
    c.arrayLen();
    mb.setBody(arrLenFn, [], c.bytes());
  }
  const capAtFn = mb.declareFunc(mb.funcType([capRef, I32], [I32]), "capAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGet(capType);
    mb.setBody(capAtFn, [], c.bytes());
  }
  const capSetFn = mb.declareFunc(mb.funcType([capRef, I32, I32], []), "capSet");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.localGet(2);
    c.arraySet(capType);
    mb.setBody(capSetFn, [], c.bytes());
  }

  mb.exportFunc("lit", litFn);
  mb.exportFunc("bcLit", bcLitFn);
  mb.exportFunc("arrLen", arrLenFn);
  mb.exportFunc("capAt", capAtFn);
  mb.exportFunc("capSet", capSetFn);
  mb.exportFunc("getChar", interp.getChar());
  mb.exportFunc("peekChar", interp.peekChar());
  mb.exportFunc("peekPrevChar", interp.peekPrevChar());
  mb.exportFunc("prevChar", interp.prevChar());
  mb.exportFunc("ensureStackSpace", interp.ensureStackSpace());
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("readU8", interp.readU8());
  mb.exportFunc("readU16", interp.readU16());
  mb.exportFunc("readU32", interp.readU32());
  mb.exportFunc("testDispatchLoop", interp.testDispatchLoop());
  mb.exportFunc("noMatch", interp.noMatch());
  mb.exportFunc("stackLit", stackLitFn);
  mb.exportFunc("rangeSearch", interp.rangeSearch());
  mb.exportFunc("saveCaptureCheck", interp.saveCaptureCheck());
  mb.exportFunc("lookaheadMatch", interp.lookaheadMatch());
  mb.exportFunc("backRefCompare", interp.backRefCompare());

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`regex-interpreter core module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as CoreExports;
}

function lit(ex: CoreExports, key: string): unknown {
  const i = LIT_KEYS.indexOf(key);
  if (i < 0) throw new Error(`no literal "${key}"`);
  return ex.lit(i);
}
function bcLit(ex: CoreExports, key: string): unknown {
  const i = BC_KEYS.indexOf(key);
  if (i < 0) throw new Error(`no bytecode literal "${key}"`);
  return ex.bcLit(i);
}
function stackLit(ex: CoreExports, key: string): unknown {
  const i = STACK_KEYS.indexOf(key);
  if (i < 0) throw new Error(`no stack literal "${key}"`);
  return ex.stackLit(i);
}

describe("regex-interpreter.ts: getChar (GET_CHAR, libregexp.c:2631-2648)", () => {
  test("ASCII, non-unicode: reads one code unit, advances by 1, no combination", async () => {
    const ex = await build();
    const [cp, newIdx] = ex.getChar(lit(ex, "ascii"), 0, 0);
    expect(cp).toBe("a".charCodeAt(0));
    expect(newIdx).toBe(1);
  });

  test("astral pair, isUnicode=1: COMBINES into one code point, advances by 2", async () => {
    const ex = await build();
    const [cp, newIdx] = ex.getChar(lit(ex, "astral"), 0, 1);
    expect(cp).toBe(0x1f600);
    expect(newIdx).toBe(2);
  });

  test("astral pair, isUnicode=0: does NOT combine — reads just the high surrogate, advances by 1", async () => {
    const ex = await build();
    const [cp, newIdx] = ex.getChar(lit(ex, "astral"), 0, 0);
    expect(cp).toBe(0xd83d); // the raw high surrogate code unit, uncombined
    expect(newIdx).toBe(1);
  });

  test("a lone high surrogate at the END of the string (no low surrogate to pair with): no combination, even under isUnicode=1", async () => {
    const ex = await build();
    const [cp, newIdx] = ex.getChar(lit(ex, "loneHighAtEnd"), 1, 1);
    expect(cp).toBe(0xd83d);
    expect(newIdx).toBe(2); // idx+1, NOT idx+2 — nothing to combine with
  });

  test("a low surrogate NOT preceded by a high surrogate: read as a plain code unit, no combination", async () => {
    const ex = await build();
    const [cp, newIdx] = ex.getChar(lit(ex, "loneLowFirst"), 0, 1);
    expect(cp).toBe(0xde00);
    expect(newIdx).toBe(1);
  });
});

describe("regex-interpreter.ts: readU8/readU16/readU32 (little-endian bytecode operand reads)", () => {
  test("readU8 reads a single byte at the given position", async () => {
    const ex = await build();
    const bc = bcLit(ex, "simple"); // [0x12, 0x34, 0x56, 0x78, 0x9a]
    expect(ex.readU8(bc, 0)).toBe(0x12);
    expect(ex.readU8(bc, 4)).toBe(0x9a);
  });
  test("readU16 reads two bytes little-endian", async () => {
    const ex = await build();
    const bc = bcLit(ex, "simple");
    expect(ex.readU16(bc, 0)).toBe(0x3412); // bytes 0x12,0x34 -> 0x3412
    expect(ex.readU16(bc, 1)).toBe(0x5634);
  });
  test("readU32 reads four bytes little-endian", async () => {
    const ex = await build();
    const bc = bcLit(ex, "simple");
    expect(ex.readU32(bc, 0)).toBe(0x78563412);
  });
  test("readU32 with all-0xFF bytes: the sign bit round-trips correctly through i32 (>>> 0 gives back 0xFFFFFFFF)", async () => {
    const ex = await build();
    const bc = bcLit(ex, "allFF");
    expect(ex.readU32(bc, 0) >>> 0).toBe(0xffffffff);
  });
});

describe("regex-interpreter.ts: newCaptureArray (fills with -1, matching lre_exec's own capture[i]=NULL loop)", () => {
  test("every slot is -1 immediately after allocation", async () => {
    const ex = await build();
    const arr = ex.newCaptureArray(3); // 2*3 = 6 slots
    expect(ex.arrLen(arr)).toBe(6);
    for (let i = 0; i < 6; i++) expect(ex.capAt(arr, i)).toBe(-1);
  });
  test("count=0 produces a zero-length array", async () => {
    const ex = await build();
    const arr = ex.newCaptureArray(0);
    expect(ex.arrLen(arr)).toBe(0);
  });
});

describe("regex-interpreter.ts: ensureStackSpace (the growable-backtrack-stack primitive)", () => {
  test("already has enough room: returns the SAME array (identity-preserving fast path)", async () => {
    const ex = await build();
    const arr = ex.newCaptureArray(10); // 20 slots, plenty of room
    const grown = ex.ensureStackSpace(arr, 0, 4);
    expect(grown).toBe(arr); // same reference, not a copy
  });
  test("needs more room: returns a LARGER array with the [0,sp) prefix preserved", async () => {
    const ex = await build();
    const arr = ex.newCaptureArray(1); // 2 slots
    // deliberately overwrite one slot so we can verify the copy preserved it
    // (newCaptureArray fills with -1; write a distinguishing value via a
    // capture write isn't exposed here, so instead just grow FAR past
    // the current size and confirm the resulting array is at least that big).
    const grown = ex.ensureStackSpace(arr, 2, 100);
    expect(ex.arrLen(grown)).toBeGreaterThanOrEqual(102);
    // the preserved prefix [0,2) should still read back -1 (copied, not garbage)
    expect(ex.capAt(grown, 0)).toBe(-1);
    expect(ex.capAt(grown, 1)).toBe(-1);
  });
});

describe("regex-interpreter.ts: emitSwitch (the br_table dispatch mechanism, tested via testDispatchLoop BEFORE exec() trusts it)", () => {
  // Opcode meanings in this TEST-ONLY bytecode: 0/1/2 add 10/20/30 to an
  // accumulator and CONTINUE the loop; anything else STOPS and returns
  // the accumulator. This exercises the exact mechanics exec()'s real
  // dispatch loop needs: several cases in ONE switch, each falling
  // through to a genuine loop CONTINUE without leaking into a
  // neighboring case's body (the failure mode a wrong `br` depth would
  // produce — silently running the WRONG case's code, or an infinite
  // loop, not a validator error), and a default/terminal case that
  // EXITS the loop instead of continuing it.
  test("single opcode, case 0: adds 10 once, stops on the terminator", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "case0"))).toBe(10);
  });
  test("single opcode, case 1: adds 20 once", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "case1"))).toBe(20);
  });
  test("single opcode, case 2: adds 30 once", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "case2"))).toBe(30);
  });
  test("all three cases in sequence: 10+20+30 = 60 — proves each case CONTINUES the loop rather than falling into its neighbor or stopping early", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "allThree"))).toBe(60);
  });
  test("repeated same case: three 20s in a row = 60 — proves re-dispatch on each loop iteration re-reads a FRESH opcode, not a stuck/latched one", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "repeatedCase1"))).toBe(60);
  });
  test("terminator FIRST: an empty sum, proving the default path doesn't require having run any case first", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "terminatorFirst"))).toBe(0);
  });
  test("reversed order (2,1,0) still sums correctly and in the SAME total regardless of order — a control against a hidden case-index-dependent bug", async () => {
    const ex = await build();
    expect(ex.testDispatchLoop(bcLit(ex, "reversedOrder"))).toBe(60);
  });
});

describe("regex-interpreter.ts: noMatch (the generic backtrack-pop loop, tested against SYNTHETIC stacks BEFORE exec() trusts it)", () => {
  // stopType=1 (RE_EXEC_STATE_LOOKAHEAD) throughout this describe block
  // — exec()'s own gotoNoMatch always passes this value; these pins
  // exercise the SAME arm noMatch's own pre-parameterization pins
  // always did. The discriminating-stopType pins (proving the
  // parameter is genuinely load-bearing, not just present) live in
  // their own describe block below.
  test("bp == 0 (no backtrack points): shouldReturn0=1 immediately, regardless of what's on the stack", async () => {
    const ex = await build();
    const stack = stackLit(ex, "oneSplitFromBase");
    const captureOut = ex.newCaptureArray(1);
    const [shouldReturn0, newPc, newCptr, newBp, newSp] = ex.noMatch(stack, 4, 0, captureOut, 1, 1);
    expect(shouldReturn0).toBe(1);
    expect(newPc).toBe(0);
    expect(newCptr).toBe(0);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
  });

  test("one SPLIT entry: pops it, restores (pc, cptr, bp=0), stops (bp reached the base)", async () => {
    const ex = await build();
    const stack = stackLit(ex, "oneSplitFromBase"); // [pc=100, cptr=5, bp=0, type=SPLIT]
    const captureOut = ex.newCaptureArray(1);
    const [shouldReturn0, newPc, newCptr, newBp, newSp] = ex.noMatch(stack, 4, 4, captureOut, 1, 1);
    expect(shouldReturn0).toBe(0);
    expect(newPc).toBe(100);
    expect(newCptr).toBe(5);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
  });

  test("two chained SPLIT entries: ONE call pops only the top one, restoring bp to the FIRST entry's own base (not 0) — a SECOND call is needed to fully unwind", async () => {
    const ex = await build();
    const stack = stackLit(ex, "twoSplitsChained"); // entry1=[100,5,0,SPLIT], entry2=[200,8,4,SPLIT]
    const captureOut = ex.newCaptureArray(1);
    const first = ex.noMatch(stack, 8, 8, captureOut, 1, 1);
    expect(first).toEqual([0, 200, 8, 4, 4]); // popped entry 2; bp restored to 4, not 0
    const second = ex.noMatch(stack, first[4], first[3], captureOut, 1, 1);
    expect(second).toEqual([0, 100, 5, 0, 0]); // popped entry 1; bp reaches 0
  });

  test("a LOOKAHEAD entry sitting above a SPLIT entry: ONE call skips over the LOOKAHEAD (per the reference's own `if (type != LOOKAHEAD) break`) and lands directly on the SPLIT beneath, in a SINGLE noMatch call — proves the outer loop's own continue-past-lookahead logic actually fires", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadAboveSplit"); // entry1=[100,5,0,SPLIT], entry2=[250,9,4,LOOKAHEAD]
    const captureOut = ex.newCaptureArray(1);
    const result = ex.noMatch(stack, 8, 8, captureOut, 1, 1);
    expect(result).toEqual([0, 100, 5, 0, 0]); // skipped the LOOKAHEAD entirely, landed on the SPLIT
  });

  test("undo-capture: a capture written ABOVE bp gets restored to its PRE-write value on pop, not just left alone", async () => {
    const ex = await build();
    const stack = stackLit(ex, "splitWithCaptureSaveOnTop"); // [pc=100,cptr=5,bp=0,SPLIT, capIdx=1, oldVal=-1]
    const captureOut = ex.newCaptureArray(2); // 4 slots, all -1 initially
    // Simulate SAVE_CAPTURE's own "overwrite AFTER pushing the old
    // value" step, which noMatch's caller (exec) would already have
    // done before ever reaching a failure: captureOut[1] now holds a
    // NEW value (7) that does NOT match the OLD value (-1) sitting on
    // the stack at offset 5 (this fixture's own construction) — this is
    // what makes the pin DISCRIMINATING: if the undo step were a no-op,
    // captureOut[1] would stay 7, not revert to -1.
    ex.capSet(captureOut, 1, 7);
    expect(ex.capAt(captureOut, 1)).toBe(7); // sanity: the write landed
    const [shouldReturn0, newPc, newCptr, newBp, newSp] = ex.noMatch(stack, 6, 4, captureOut, 1, 1);
    expect(shouldReturn0).toBe(0);
    expect(newPc).toBe(100);
    expect(newCptr).toBe(5);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
    expect(ex.capAt(captureOut, 1), "captureOut[1] restored to the stack's own saved OLD value, not left at 7").toBe(-1);
  });
});

describe("regex-interpreter.ts: peekChar (PEEK_CHAR — like getChar, but does NOT advance)", () => {
  test("ASCII: reads the code unit, calling it TWICE at the same idx gives the SAME result (proves it never advances)", async () => {
    const ex = await build();
    const subj = lit(ex, "ascii");
    expect(ex.peekChar(subj, 0, 0)).toBe("a".charCodeAt(0));
    expect(ex.peekChar(subj, 0, 0)).toBe("a".charCodeAt(0)); // same idx, same result
  });
  test("astral pair, isUnicode=1: combines, matching getChar's own codePoint result at the same idx", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    const [getCharCp] = ex.getChar(subj, 0, 1);
    expect(ex.peekChar(subj, 0, 1)).toBe(getCharCp);
    expect(ex.peekChar(subj, 0, 1)).toBe(0x1f600);
  });
  test("astral pair, isUnicode=0: no combination — raw high surrogate", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    expect(ex.peekChar(subj, 0, 0)).toBe(0xd83d);
  });
  test("lone high surrogate at the end: no combination even under isUnicode=1", async () => {
    const ex = await build();
    const subj = lit(ex, "loneHighAtEnd");
    expect(ex.peekChar(subj, 1, 1)).toBe(0xd83d);
  });
});

describe("regex-interpreter.ts: peekPrevChar (PEEK_PREV_CHAR — reads idx-1, combining BACKWARD with idx-2, without moving idx)", () => {
  test("astral pair: peeking from idx=2 (right after it) combines with idx-2=0 as the high surrogate", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    expect(ex.peekPrevChar(subj, 2, 1)).toBe(0x1f600);
  });
  test("astral pair, isUnicode=0: no combination — raw low surrogate", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    expect(ex.peekPrevChar(subj, 2, 0)).toBe(0xde00);
  });
  test("a low surrogate at idx-1 with NOTHING before it (idx-2 < 0): no combination, boundary guard holds", async () => {
    const ex = await build();
    const subj = lit(ex, "loneLowFirst"); // "\ude00a" — low surrogate at index 0
    expect(ex.peekPrevChar(subj, 1, 1)).toBe(0xde00);
  });
  test("a low surrogate at idx-1 whose PRECEDING code unit exists but is NOT a high surrogate: no combination", async () => {
    const ex = await build();
    const subj = lit(ex, "charThenLoneLow"); // "a\ude00"
    expect(ex.peekPrevChar(subj, 2, 1)).toBe(0xde00);
  });
});

describe("regex-interpreter.ts: prevChar (PREV_CHAR — moves idx backward by one character, combining BACKWARD under isUnicode)", () => {
  test("ASCII: steps back by exactly 1", async () => {
    const ex = await build();
    const subj = lit(ex, "ascii");
    expect(ex.prevChar(subj, 1, 0)).toBe(0);
  });
  test("astral pair, isUnicode=1: steps back by 2 (combines), landing BEFORE the whole pair", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    expect(ex.prevChar(subj, 2, 1)).toBe(0);
  });
  test("astral pair, isUnicode=0: steps back by only 1 (no combination) — lands BETWEEN the two surrogates", async () => {
    const ex = await build();
    const subj = lit(ex, "astral");
    expect(ex.prevChar(subj, 2, 0)).toBe(1);
  });
  test("a low surrogate with nothing before it (idx-2 < 0): steps back by only 1, boundary guard holds", async () => {
    const ex = await build();
    const subj = lit(ex, "loneLowFirst");
    expect(ex.prevChar(subj, 1, 1)).toBe(0);
  });
  test("a low surrogate whose predecessor is NOT a high surrogate: steps back by only 1", async () => {
    const ex = await build();
    const subj = lit(ex, "charThenLoneLow");
    expect(ex.prevChar(subj, 2, 1)).toBe(1);
  });
});

describe("rangeSearch (the shared binary-search-over-sorted-ranges core behind REOP_range/range32 and REOP_space/not_space's fixed tables, libregexp.c:3241-3319)", () => {
  test("single 16-bit pair: below/at-low/inside/at-high/above", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeSingle16");
    expect(ex.rangeSearch(table, 0, 1, 0, 5), "below low").toBe(0);
    expect(ex.rangeSearch(table, 0, 1, 0, 10), "at low").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 0, 15), "inside").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 0, 20), "at high").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 0, 21), "above high").toBe(0);
  });
  test("three 16-bit pairs: each range, the gaps between them, and outside the whole span — exercises the actual binary search, not just the pair[0]/pair[n-1] early checks", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeMulti16");
    expect(ex.rangeSearch(table, 0, 3, 0, 5), "below everything").toBe(0);
    expect(ex.rangeSearch(table, 0, 3, 0, 15), "first range").toBe(1);
    expect(ex.rangeSearch(table, 0, 3, 0, 25), "gap between first and second").toBe(0);
    expect(ex.rangeSearch(table, 0, 3, 0, 35), "second (middle) range").toBe(1);
    expect(ex.rangeSearch(table, 0, 3, 0, 45), "gap between second and third").toBe(0);
    expect(ex.rangeSearch(table, 0, 3, 0, 55), "third range").toBe(1);
    expect(ex.rangeSearch(table, 0, 3, 0, 65), "above everything").toBe(0);
  });
  test("16-bit infinity sentinel (last pair's high === 0xffff): an ASTRAL c matches via the special case, not via a numeric comparison that would wrongly reject it", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeInfinity16");
    expect(ex.rangeSearch(table, 0, 2, 0, 0x10000), "astral c, sentinel range: MUST match").toBe(1);
    expect(ex.rangeSearch(table, 0, 2, 0, 0xffff), "c === 0xffff exactly also matches (>= in the reference's own condition)").toBe(1);
    expect(ex.rangeSearch(table, 0, 2, 0, 50), "in the GAP, not astral: sentinel must not spuriously fire").toBe(0);
    expect(ex.rangeSearch(table, 0, 2, 0, 150), "genuinely inside the sentinel range, well under 0xffff").toBe(1);
  });
  test("an astral c against a table whose last high is NOT 0xffff: the sentinel must not fire for an unrelated table", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeSingle16");
    expect(ex.rangeSearch(table, 0, 1, 0, 0x10000)).toBe(0);
  });
  test("single 32-bit pair (astral span): below/at-low/inside/at-high/above — no infinity sentinel exists for this form", async () => {
    const ex = await build();
    const table = bcLit(ex, "range32Single");
    expect(ex.rangeSearch(table, 0, 1, 1, 0xffff), "below low").toBe(0);
    expect(ex.rangeSearch(table, 0, 1, 1, 0x10000), "at low").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 1, 0x108000), "inside").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 1, 0x10ffff), "at high").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 1, 0x110000), "above high").toBe(0);
  });
  test("two 32-bit pairs: each range, the gap, and outside the span", async () => {
    const ex = await build();
    const table = bcLit(ex, "range32Multi");
    expect(ex.rangeSearch(table, 0, 2, 1, 0xffff), "below everything").toBe(0);
    expect(ex.rangeSearch(table, 0, 2, 1, 0x10200), "first range").toBe(1);
    expect(ex.rangeSearch(table, 0, 2, 1, 0x10500), "gap between the two ranges").toBe(0);
    expect(ex.rangeSearch(table, 0, 2, 1, 0x25000), "second range").toBe(1);
    expect(ex.rangeSearch(table, 0, 2, 1, 0x30000), "above everything").toBe(0);
  });
  test("pos offset: the table is read starting at a NON-ZERO position, not an implicit array-base-0 assumption — TABLE_POS in real bytecode is never 0", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeSingle16Padded");
    expect(ex.rangeSearch(table, 4, 1, 0, 5), "below low, read from pos=4").toBe(0);
    expect(ex.rangeSearch(table, 4, 1, 0, 15), "inside, read from pos=4").toBe(1);
    expect(ex.rangeSearch(table, 4, 1, 0, 21), "above high, read from pos=4").toBe(0);
  });
  test("n restricts the search to fewer pairs than the table array actually holds — n travels as its own parameter, not derived from array length", async () => {
    const ex = await build();
    const table = bcLit(ex, "rangeMulti16"); // 3 pairs, but told there's only 1
    expect(ex.rangeSearch(table, 0, 1, 0, 15), "n=1 restricts the search to just the FIRST pair").toBe(1);
    expect(ex.rangeSearch(table, 0, 1, 0, 35), "n=1: the second pair's range must be UNREACHABLE").toBe(0);
  });
});

describe("saveCaptureCheck (SAVE_CAPTURE_CHECK, libregexp.c:2824-2843 — 'avoid saving the previous value if already saved')", () => {
  test("found immediately (matching entry sits at the TOP of the segment): no push, stack/sp unchanged, captureOut written", async () => {
    const ex = await build();
    const stack = stackLit(ex, "saveCheckTwoEntries"); // [3,10, 5,20]
    const captureOut = ex.newCaptureArray(3); // slots 0..5, all -1
    const [newStack, newSp] = ex.saveCaptureCheck(stack, 4, 0, captureOut, 5, 999);
    expect(newSp, "sp unchanged — no push").toBe(4);
    expect(ex.arrLen(newStack), "stack length unchanged — no push").toBe(4);
    expect(ex.capAt(newStack, 2), "entry1's idx untouched").toBe(5);
    expect(ex.capAt(newStack, 3), "entry1's OLD value untouched (not re-pushed)").toBe(20);
    expect(ex.capAt(captureOut, 5), "captureOut[idx] written to the new value").toBe(999);
  });
  test("found after scanning PAST one non-matching entry: proves the scan genuinely walks backward through multiple entries, not just the top one", async () => {
    const ex = await build();
    const stack = stackLit(ex, "saveCheckScanPastOne"); // [8,111, 5,222] — search idx=8, which sits BELOW entry1 (idx=5)
    const captureOut = ex.newCaptureArray(5);
    const [newStack, newSp] = ex.saveCaptureCheck(stack, 4, 0, captureOut, 8, 42);
    expect(newSp, "sp unchanged — no push, even though the match wasn't at the top").toBe(4);
    expect(ex.arrLen(newStack)).toBe(4);
    expect(ex.capAt(captureOut, 8)).toBe(42);
  });
  test("push at the segment boundary: a MATCHING idx exists but only BELOW bp — must be treated as not-found, proving the scan genuinely stops at bp rather than scanning the whole stack", async () => {
    const ex = await build();
    const stack = stackLit(ex, "saveCheckTwoEntries"); // [3,10, 5,20] — idx=3 exists at [0,1], but bp=2 excludes it
    const captureOut = ex.newCaptureArray(3);
    ex.capSet(captureOut, 3, -7); // a known sentinel "old value" to verify gets pushed
    const [newStack, newSp] = ex.saveCaptureCheck(stack, 4, 2, captureOut, 3, 555);
    expect(newSp, "sp GREW by 2 — a new entry was pushed").toBe(6);
    expect(ex.arrLen(newStack)).toBeGreaterThanOrEqual(6);
    expect(ex.capAt(newStack, 4), "the pushed entry's idx").toBe(3);
    expect(ex.capAt(newStack, 5), "the pushed entry's OLD value, from captureOut BEFORE this call").toBe(-7);
    expect(ex.capAt(captureOut, 3), "captureOut[idx] written to the new value").toBe(555);
  });
});

describe("lookaheadMatch (REOP_lookahead_match, libregexp.c:2884-2916 — NOT a transcription of the reference's own packed-pointer trick; see findings-p1-v1.txt's own design-trace entry for the hand-traced equivalence proof)", () => {
  test("a single LOOKAHEAD marker, nothing else: found on the FIRST check, sp/bp/pc/cptr restored from it directly", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadAlone");
    const [, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 4, 4);
    expect(newPc).toBe(500);
    expect(newCptr).toBe(7);
    expect(newBp).toBe(0);
    // newSp, not the returned array's OWN .length, tracks the logical
    // top — array.copy overwrites elements in place, it never shrinks
    // the array itself (the same reason noMatch's own pins never check
    // arrLen after a pop either).
    expect(newSp).toBe(0);
  });
  test("an intervening SPLIT marker between the lookahead marker and the top: BOTH markers removed, all THREE capture-save entries preserved and compacted contiguously — the design trace's own hand-traced example, transcribed almost verbatim", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadWithInterveningSplit");
    const [newStack, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 14, 10);
    expect(newPc, "pc from the LOOKAHEAD marker itself, not the intervening split").toBe(500);
    expect(newCptr).toBe(7);
    expect(newBp).toBe(0);
    expect(newSp, "3 capture-saves preserved (6 slots), both 4-slot markers removed").toBe(6);
    expect(ex.capAt(newStack, 0), "capSave1's idx").toBe(3);
    expect(ex.capAt(newStack, 1), "capSave1's old value").toBe(99);
    expect(ex.capAt(newStack, 2), "capSave2's idx").toBe(5);
    expect(ex.capAt(newStack, 3), "capSave2's old value").toBe(88);
    expect(ex.capAt(newStack, 4), "capSave3's idx").toBe(9);
    expect(ex.capAt(newStack, 5), "capSave3's old value").toBe(77);
  });
  test("two LOOKAHEAD-type markers stacked: stops at the NEAREST one, never walks past it looking for the other", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadTwoStacked");
    const [newStack, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 8, 8);
    expect(newPc, "pc from marker B, the NEAR one — never marker A's 100").toBe(200);
    expect(newCptr).toBe(20);
    expect(newBp).toBe(0);
    expect(newSp, "only marker B removed — marker A at [0,4) is untouched/unreached").toBe(4);
    expect(ex.capAt(newStack, 0), "marker A's own pc, still sitting there, unreached").toBe(100);
  });
  test("zero preserved capture-saves in EITHER segment: every array.copy this walk performs is a genuine zero-length no-op", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadZeroSavesBothSegments");
    const [, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 8, 8);
    expect(newPc).toBe(500);
    expect(newCptr).toBe(7);
    expect(newBp).toBe(0);
    expect(newSp, "both markers discarded, nothing preserved — sp collapses to 0").toBe(0);
  });
  test("a capture-save BELOW the lookahead marker's own position is left ENTIRELY untouched — the compaction only ever reaches [bp,sp), never below it", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadSavesBelowMarker"); // capSaveBelow at [0,2), LOOKAHEAD marker at [2,6), capSaveAbove at [6,8)
    const [newStack, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 8, 6);
    expect(newPc).toBe(400);
    expect(newCptr).toBe(40);
    expect(newBp).toBe(0);
    expect(newSp, "capSaveAbove compacted down to sit right after capSaveBelow").toBe(4);
    expect(ex.capAt(newStack, 0), "capSaveBelow's idx, UNTOUCHED by this call").toBe(99);
    expect(ex.capAt(newStack, 1), "capSaveBelow's old value, UNTOUCHED").toBe(88);
    expect(ex.capAt(newStack, 2), "capSaveAbove's idx, now compacted down to position 2").toBe(3);
    expect(ex.capAt(newStack, 3), "capSaveAbove's old value").toBe(77);
  });
  test("an UNEXPECTED marker type (NEGATIVE_LOOKAHEAD, not SPLIT) sitting above the target: treated the SAME as any other non-target type — skipped, not stopped at, not trapped — proving the mechanism directly rather than resting on 'by construction this can't happen' alone (this port's own established precedent for unreachable-by-construction shapes, char32_i/REOP_prev)", async () => {
    const ex = await build();
    const stack = stackLit(ex, "lookaheadSkipsUnexpectedType");
    const [, newPc, newCptr, newBp, newSp] = ex.lookaheadMatch(stack, 8, 8);
    expect(newPc, "pc from the LOOKAHEAD target, not the skipped NEGATIVE_LOOKAHEAD marker's 999").toBe(500);
    expect(newCptr).toBe(7);
    expect(newBp).toBe(0);
    expect(newSp, "both markers discarded, nothing preserved").toBe(0);
  });
});

describe("noMatch, compareType=NEGATIVE_LOOKAHEAD/continueOnEqual=false (the parameterized noMatch's OWN discriminating shape — emitNegativeLookaheadMatch's first call, unwindToType(NEGATIVE_LOOKAHEAD, false) in regex-interpreter.ts; the lead's FINAL ruling, reconsidering an earlier leaning toward a dedicated second loop, since this loop and the compareType=LOOKAHEAD/continueOnEqual=true one above share their ENTIRE per-iteration body — even though it turned out to need TWO varying parameters, not the one originally estimated, since the two loops' own stop conditions are OPPOSITE polarity; see noMatch's own doc comment)", () => {
  test("a single NEGATIVE_LOOKAHEAD marker, nothing else: found on the FIRST check", async () => {
    const ex = await build();
    const stack = stackLit(ex, "negLookaheadAlone");
    const captureOut = ex.newCaptureArray(1);
    const [shouldReturn0, pc, cptr, newBp, newSp] = ex.noMatch(stack, 4, 4, captureOut, 2, 0);
    expect(shouldReturn0).toBe(0);
    expect(pc).toBe(700);
    expect(cptr).toBe(11);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
  });
  test("an intervening SPLIT marker is SKIPPED (not mistaken for the target), and the capture-save encountered along the way IS undone — the deliberate opposite of lookaheadMatch's own preserve-never-undo", async () => {
    const ex = await build();
    const stack = stackLit(ex, "negLookaheadWithInterveningSplit");
    const captureOut = ex.newCaptureArray(3);
    ex.capSet(captureOut, 2, 555); // a "current" value that must get undone back to -1
    const [shouldReturn0, pc, cptr, newBp, newSp] = ex.noMatch(stack, 10, 10, captureOut, 2, 0);
    expect(shouldReturn0).toBe(0);
    expect(pc, "pc from the NEGATIVE_LOOKAHEAD marker, not the skipped split").toBe(700);
    expect(cptr).toBe(11);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
    expect(ex.capAt(captureOut, 2), "the capture-save encountered en route was UNDONE, unlike lookaheadMatch's own preserve").toBe(-1);
  });
  test("a LOOKAHEAD-type marker (not SPLIT) sitting above the target is ALSO skipped, not mistaken for a stop condition — discriminates against a bug that stops at 'anything non-SPLIT' rather than specifically the given stopType", async () => {
    const ex = await build();
    const stack = stackLit(ex, "negLookaheadAboveLookahead");
    const captureOut = ex.newCaptureArray(1);
    const [shouldReturn0, pc, cptr, newBp, newSp] = ex.noMatch(stack, 8, 8, captureOut, 2, 0);
    expect(shouldReturn0).toBe(0);
    expect(pc, "pc from the NEGATIVE_LOOKAHEAD marker, not the skipped LOOKAHEAD one").toBe(700);
    expect(cptr).toBe(11);
    expect(newBp).toBe(0);
    expect(newSp).toBe(0);
  });
  test("the parameter is PROVABLY LOAD-BEARING: the SAME fixture, SAME sp/bp, only stopType differs, produces a DIFFERENT final state either way — not just 'noMatch generically works with some stopType value'", async () => {
    const ex = await build();
    const stack = stackLit(ex, "negLookaheadWithInterveningSplit"); // NEGATIVE_LOOKAHEAD marker at [0,4)=pc700, capSave, SPLIT marker at [6,10)=pc800
    const captureOutA = ex.newCaptureArray(3);
    const [, pcStoppingAtNegLookahead] = ex.noMatch(stack, 10, 10, captureOutA, 2, 0); // stopType=NEGATIVE_LOOKAHEAD: walks PAST the split, stops at the negative-lookahead marker
    const captureOutB = ex.newCaptureArray(3);
    const [, pcStoppingAtSplit] = ex.noMatch(stack, 10, 10, captureOutB, 1, 1); // stopType=LOOKAHEAD: the split's own type(0) already != 1, so it stops there IMMEDIATELY instead
    expect(pcStoppingAtNegLookahead, "stopType=NEGATIVE_LOOKAHEAD walks past the split to its own marker").toBe(700);
    expect(pcStoppingAtSplit, "stopType=LOOKAHEAD stops at the FIRST non-matching marker it meets — the split itself").toBe(800);
    expect(pcStoppingAtNegLookahead).not.toBe(pcStoppingAtSplit);
  });
});

describe("backRefCompare (REOP_back_reference(_i)/backward_back_reference(_i)'s own character-comparison walk, libregexp.c:3184-3240 — built as its OWN standalone function; see findings-p1-v1.txt's own design-trace entry for why)", () => {
  test("forward match: 'abc' at [0,3) against 'abc' starting at cptr=3 — full match, cptr advances past it", async () => {
    const ex = await build();
    const subject = lit(ex, "abcabc");
    const [matches, newCptr] = ex.backRefCompare(subject, 3, 0, 3, 0, 0, 0);
    expect(matches).toBe(1);
    expect(newCptr).toBe(6);
  });
  test("forward mismatch: the LAST character differs ('abc' vs 'abd') — fails on the third comparison, cptr already advanced through the first two matches PLUS the mismatching read itself", async () => {
    const ex = await build();
    const subject = lit(ex, "abcabd");
    const [matches, newCptr] = ex.backRefCompare(subject, 3, 0, 3, 0, 0, 0);
    expect(matches).toBe(0);
    expect(newCptr, "cptr already read past the mismatching character before the check fires").toBe(6);
  });
  test("forward exhaustion: cptr is already at the subject's own end before any comparison runs — fails immediately, cptr UNCHANGED", async () => {
    const ex = await build();
    const subject = lit(ex, "abca"); // length 4
    const [matches, newCptr] = ex.backRefCompare(subject, 4, 0, 3, 0, 0, 0);
    expect(matches).toBe(0);
    expect(newCptr, "exhaustion is checked BEFORE any read — cptr never moves").toBe(4);
  });
  test("backward match: 'abc' at [0,3) walked backward against the SAME text ending at cptr=6 — full match, cptr moves back past it", async () => {
    const ex = await build();
    const subject = lit(ex, "abcabc");
    const [matches, newCptr] = ex.backRefCompare(subject, 6, 0, 3, 0, 1, 0);
    expect(matches).toBe(1);
    expect(newCptr).toBe(3);
  });
  test("backward mismatch: matches on the FIRST (rightmost) character, mismatches on the second — proves the backward walk genuinely compares character by character, not just checks endpoints", async () => {
    const ex = await build();
    const subject = lit(ex, "xyzxwz");
    const [matches, newCptr] = ex.backRefCompare(subject, 6, 0, 3, 0, 1, 0);
    expect(matches).toBe(0);
    expect(newCptr).toBe(4);
  });
  test("backward exhaustion: cptr is already 0 before any comparison runs — fails immediately, cptr UNCHANGED", async () => {
    const ex = await build();
    const subject = lit(ex, "abcabc");
    const [matches, newCptr] = ex.backRefCompare(subject, 0, 0, 1, 0, 1, 0);
    expect(matches).toBe(0);
    expect(newCptr).toBe(0);
  });
  test("ignoreCase forward: lowercase capture vs uppercase subject — a DISCRIMINATING pair, same fixture and position, only ignoreCase differs, opposite results", async () => {
    const ex = await build();
    const subject = lit(ex, "abcABC");
    const [matchesIgnoreCase] = ex.backRefCompare(subject, 3, 0, 3, 0, 0, 1);
    const [matchesCaseSensitive] = ex.backRefCompare(subject, 3, 0, 3, 0, 0, 0);
    expect(matchesIgnoreCase, "canonicalized on both sides, matches despite the case difference").toBe(1);
    expect(matchesCaseSensitive, "no canonicalize: case-sensitive comparison fails").toBe(0);
  });
  test("zero-length capture (capStart===capEnd): trivially succeeds with ZERO iterations, cptr UNCHANGED — matches ECMA-262's own 'a backreference to an unset/empty group matches empty' rule", async () => {
    const ex = await build();
    const subject = lit(ex, "abcabc");
    const [matches, newCptr] = ex.backRefCompare(subject, 0, 2, 2, 0, 0, 0);
    expect(matches).toBe(1);
    expect(newCptr, "zero iterations ran — cptr was never touched").toBe(0);
  });
});

