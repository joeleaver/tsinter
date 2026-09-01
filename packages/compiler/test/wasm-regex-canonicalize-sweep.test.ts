/* INC-24 P1, CP4 back half: design §6.2's own two ORACLE SWEEPS
 * (single-char + class), reproduced at design scale (65,960 exhaustive
 * + 187,638 sampled true-negatives for single-char; 571,392 for the
 * class sweep over 9 probe classes — des/probes/node/canonicalize-
 * sweep.mjs and class-canonicalize.mjs, MEASUREMENTS.txt §26b/A-4) —
 * but run THROUGH THIS PORT'S OWN exec() INTERPRETER, not the design
 * probes' own JS predictor function. The design probes proved the
 * FORMULA is Node-exact; this proves THIS PORT'S WASM BUILD of that
 * formula (regexCanonicalize, wired into REOP_char_i/REOP_range_i) is
 * Node-exact too — a different, and until now unmeasured, risk.
 *
 * MECHANISM: no per-pattern module rebuild (65,960+ distinct modules is
 * impractical) and no assemble() call in the sweeps themselves.
 * regex-ast.ts's own documented contract settles the bytecode shape:
 * for ignoreCase, the PATTERN side is already Canonicalize()'d (char) /
 * case-closed (class) at "parse time" — VAL (or the range table) is
 * read RAW from bytecode by emitTestChar/emitRangeTest and compared
 * against regexCanonicalize(subjectChar), never canonicalized itself at
 * match time. So a hand-built bytecode blob using regex-canon.ts's
 * canonicalize() / regex-class-closure.ts's caseCloseClass() as the
 * literal pattern-side operand SHOULD be exactly what this port's OWN
 * assemble() would itself emit for these patterns. THIS CLAIM IS
 * MEASURED, not just argued from reading the dispatch code: BRIDGE 1/2
 * below assemble() a real /a/i and /[a-z]/i pattern and byte-diff the
 * result against this file's own hand-built construction for the
 * identical case — byte-identical once the header's own IGNORECASE bit
 * was added (the ONE discrepancy the bridge checks actually caught; see
 * their own history in findings). So this sweep is about exec()'s own
 * runtime canonicalization correctness (REOP_char_i/REOP_range_i's
 * actual dispatch), not the assembler (a separate, already-covered gate
 * leg: the byte-comparison harness against lre_compile) — and that
 * layer split is now measured at the boundary, not merely argued.
 *
 * ONE wasm module, two exported test-runner functions, each building
 * its OWN tiny bytecode + one-code-unit subject array via
 * array.new_fixed FROM RUNTIME PARAMETERS (code.ts's arrayNewFixed,
 * already precedented elsewhere in this file's own sibling tests) —
 * only i32 primitives cross the JS/wasm boundary per call, so 65,960 +
 * 187,638 + 571,392 = 824,990 calls stay cheap in-process. No new
 * data-segment/offset marshaling invented.
 *
 * runCharITest(patternVal, subjectCp): builds save_start(0)/
 * char_i(patternVal)/save_end(0)/match and runs it — patternVal is
 * ALWAYS precomputed in JS via canonicalize(c), matching what the real
 * parser would have embedded.
 *
 * runClassTest(classIndex, subjectCp): builds save_start(0)/
 * range_i(table)/save_end(0)/match for one of 9 FIXED classes (their
 * table bytes computed once at module-build time via emitRange over
 * caseCloseClass(...), same closure function regex-class-closure.ts's
 * own tests already validate) and runs it.
 */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { canonicalize } from "../src/backend/wasm/regex-canon.js";
import { caseCloseClass } from "../src/backend/wasm/regex-class-closure.js";
import { crInvert, type CharRange } from "../src/backend/wasm/regex-charclass.js";
import { assemble, emitRange, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { RegexByteWriter } from "../src/backend/wasm/regex-bytewriter.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";

const CP = 0x10000;
const isSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdfff;

interface SweepExports {
  runCharITest: (patternVal: number, subjectCp: number) => number;
  runClassTest: (classIndex: number, subjectCp: number) => number;
}

const RAW_CLASSES: Array<{ src: string; raw: CharRange; negated: boolean }> = [
  { src: "[a-z]", raw: [0x61, 0x7b], negated: false },
  { src: "[A-Z]", raw: [0x41, 0x5b], negated: false },
  { src: "[a-f]", raw: [0x61, 0x67], negated: false },
  { src: "[^a-z]", raw: [0x61, 0x7b], negated: true },
  { src: "[aeiou]", raw: [0x61, 0x62, 0x65, 0x66, 0x69, 0x6a, 0x6f, 0x70, 0x75, 0x76], negated: false },
  { src: "[^aeiou]", raw: [0x61, 0x62, 0x65, 0x66, 0x69, 0x6a, 0x6f, 0x70, 0x75, 0x76], negated: true },
  { src: "[\\u00c0-\\u00ff]", raw: [0xc0, 0x100], negated: false },
  { src: "[\\u0100-\\u017f]", raw: [0x100, 0x180], negated: false },
  { src: "[\\u0391-\\u03a9]", raw: [0x391, 0x3aa], negated: false },
];

/** Full REOP_range_i bytecode for one class, built the SAME way this
 * port's own PARSER actually would for a bracket class: regex-
 * charclass.ts's parseCharClass closes EACH MEMBER as it's added to
 * the class body (closeMemberIfNeeded, called per-atom) and only
 * inverts the WHOLE already-closed set at the very end for `[^...]`
 * (parseCharClass's own `if (invert) cr = crInvert(cr);`, AFTER the
 * member loop — confirmed by reading that function directly, its own
 * doc comment states this explicitly: "`[^a-z]/i` negating the
 * ALREADY-closed A-Z rather than the raw a-z"). So negated classes here
 * are crInvert(caseCloseClass(raw)) — invert LAST — matching the real
 * bracket-class pipeline exactly. (caseCloseClass(crInvert(x)) — invert
 * FIRST — is what bare \D/\W under ignoreCase use instead, a DIFFERENT
 * real code path this file doesn't exercise; it happens to be safe
 * there only because \D/\W's raw complement has no split case pair
 * crossing the negation boundary, unlike a-z.) */
function buildClassBytecode(entry: (typeof RAW_CLASSES)[number]): Uint8Array {
  const cr = entry.negated ? crInvert(caseCloseClass(entry.raw)) : caseCloseClass(entry.raw);
  const w = new RegexByteWriter();
  w.u8(0x22); // flags: STICKY(0x20) | IGNORECASE(0x02) — matches assemble()'s own flagsToBits(), confirmed byte-identical by BRIDGE 2 below
  w.u8(0x00);
  w.u8(1); // captureCount
  w.u8(0); // registerCount
  const bodyLenPos = w.size;
  w.u32(0); // placeholder, patched below
  const bodyStart = w.size;
  w.u8(19);
  w.u8(0); // save_start(0)
  emitRange(w, cr, true); // REOP_range_i + table
  w.u8(20);
  w.u8(0); // save_end(0)
  w.u8(16); // match
  w.patchU32(bodyLenPos, w.size - bodyStart);
  return w.toBytes();
}

async function build(): Promise<SweepExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const capType = mb.arrayType(I32, true);
  const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
  const interp = new RegexInterpreterBuilder(mb, strType);

  const runCharIFn = mb.declareFunc(mb.funcType([I32, I32], [I32]), "runCharITest");
  {
    const PATTERN_VAL = 0;
    const SUBJECT_CP = 1;
    const BC = 2;
    const SUBJ = 3;
    const CAP = 4;
    const c = new Code();
    // header: flags=STICKY(0x20)|IGNORECASE(0x02), captureCount=1, registerCount=0, bodyLen=8
    c.i32Const(0x22);
    c.i32Const(0x00);
    c.i32Const(1);
    c.i32Const(0);
    c.i32Const(8);
    c.i32Const(0);
    c.i32Const(0);
    c.i32Const(0);
    // body: save_start(0), char_i(patternVal), save_end(0), match
    c.i32Const(19);
    c.i32Const(0);
    c.i32Const(2); // REOP.char_i
    c.localGet(PATTERN_VAL);
    c.i32Const(0xff);
    c.i32And();
    c.localGet(PATTERN_VAL);
    c.i32Const(8);
    c.i32ShrU();
    c.i32Const(0xff);
    c.i32And();
    c.i32Const(20);
    c.i32Const(0);
    c.i32Const(16);
    c.arrayNewFixed(bcType, 16);
    c.localSet(BC);
    c.localGet(SUBJECT_CP);
    c.arrayNewFixed(strType, 1);
    c.localSet(SUBJ);
    c.i32Const(1);
    c.call(interp.newCaptureArray());
    c.localSet(CAP);
    c.localGet(BC);
    c.localGet(SUBJ);
    c.i32Const(0);
    c.localGet(CAP);
    c.call(interp.exec());
    mb.setBody(runCharIFn, [bcRef, strRef, capRef], c.bytes());
  }

  const classBytecodes = RAW_CLASSES.map(buildClassBytecode);

  const runClassFn = mb.declareFunc(mb.funcType([I32, I32], [I32]), "runClassTest");
  {
    const CLASS_INDEX = 0;
    const SUBJECT_CP = 1;
    const BC = 2;
    const SUBJ = 3;
    const CAP = 4;
    const c = new Code();
    classBytecodes.forEach((bytes, i) => {
      c.localGet(CLASS_INDEX);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      for (const b of bytes) c.i32Const(b);
      c.arrayNewFixed(bcType, bytes.length);
      c.localSet(BC);
      c.localGet(SUBJECT_CP);
      c.arrayNewFixed(strType, 1);
      c.localSet(SUBJ);
      c.i32Const(1);
      c.call(interp.newCaptureArray());
      c.localSet(CAP);
      c.localGet(BC);
      c.localGet(SUBJ);
      c.i32Const(0);
      c.localGet(CAP);
      c.call(interp.exec());
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(runClassFn, [bcRef, strRef, capRef], c.bytes());
  }

  mb.exportFunc("runCharITest", runCharIFn);
  mb.exportFunc("runClassTest", runClassFn);

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`canonicalize-sweep module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as SweepExports;
}

// ---- single-char neighbourhood construction, IDENTICAL algorithm to
// des/probes/node/canonicalize-sweep.mjs (re-derived here, not
// imported, since the probe is a standalone script outside the
// package — but every step matches that file line for line). ----
function buildNeighbourhoods(): (c: number) => Set<number> {
  const rev = new Map<number, Set<number>>();
  const addRev = (k: number, v: number): void => {
    let s = rev.get(k);
    if (!s) rev.set(k, (s = new Set()));
    s.add(v);
  };
  const up = new Int32Array(CP);
  const lo = new Int32Array(CP);
  for (let c = 0; c < CP; c++) {
    const ch = String.fromCharCode(c);
    const u = ch.toUpperCase();
    const l = ch.toLowerCase();
    up[c] = u.length === 1 ? u.charCodeAt(0) : -1;
    lo[c] = l.length === 1 ? l.charCodeAt(0) : -1;
    if (up[c]! >= 0) addRev(up[c]!, c);
    if (lo[c]! >= 0) addRev(lo[c]!, c);
  }
  return (c: number): Set<number> => {
    const s = new Set<number>([c]);
    if (up[c]! >= 0) s.add(up[c]!);
    if (lo[c]! >= 0) s.add(lo[c]!);
    for (const x of rev.get(c) ?? []) s.add(x);
    for (const y of [...s]) for (const x of rev.get(y) ?? []) s.add(x);
    s.add(canonicalize(c));
    return s;
  };
}

describe("regex canonicalize/case-closure sweeps at design scale, through real exec() (design §6.2)", () => {
  test(
    "SWEEP 1 (single-char): exhaustive true-positive neighbourhoods (65,960 pairs) + 187,638 seeded sampled true-negatives, through REOP_char_i's real exec() path",
    async () => {
      const ex = await build();
      const neighbourhood = buildNeighbourhoods();
      let exhaustiveTested = 0;
      let exhaustiveBad = 0;
      const badExamples: string[] = [];
      for (let c = 0; c < CP; c++) {
        if (isSurrogate(c)) continue;
        const patternVal = canonicalize(c);
        const nodeRe = new RegExp("^\\u" + c.toString(16).padStart(4, "0") + "$", "i");
        for (const d of neighbourhood(c)) {
          if (isSurrogate(d)) continue;
          exhaustiveTested++;
          const actual = ex.runCharITest(patternVal, d) === 1;
          const expected = nodeRe.test(String.fromCharCode(d));
          if (actual !== expected) {
            exhaustiveBad++;
            if (badExamples.length < 20) badExamples.push(`U+${c.toString(16)} vs U+${d.toString(16)}: exec=${actual} node=${expected}`);
          }
        }
      }
      expect(exhaustiveBad, badExamples.join("\n")).toBe(0);
      expect(exhaustiveTested, "exhaustive pair count must match design §6.2's own measured figure").toBe(65_960);

      // sampled true-negatives — IDENTICAL seeded LCG to canonicalize-sweep.mjs
      let seed = 12345;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      let sampledTested = 0;
      let sampledBad = 0;
      for (let i = 0; i < 200_000; i++) {
        const c = Math.floor(rnd() * CP);
        const d = Math.floor(rnd() * CP);
        if (isSurrogate(c) || isSurrogate(d)) continue;
        const patternVal = canonicalize(c);
        const actual = ex.runCharITest(patternVal, d) === 1;
        const expected = new RegExp("^\\u" + c.toString(16).padStart(4, "0") + "$", "i").test(String.fromCharCode(d));
        sampledTested++;
        if (actual !== expected) {
          sampledBad++;
          if (badExamples.length < 20) badExamples.push(`SAMPLED U+${c.toString(16)} vs U+${d.toString(16)}: exec=${actual} node=${expected}`);
        }
      }
      expect(sampledBad, badExamples.join("\n")).toBe(0);
      expect(sampledTested, "sampled pair count must match design §6.2's own measured figure").toBe(187_638);
    },
    120_000,
  );

  test(
    "SWEEP 2 (class): 9 probe classes exhaustive over the BMP (571,392 pairs), through REOP_range_i's real exec() path",
    async () => {
      const ex = await build();
      let totalTested = 0;
      let totalBad = 0;
      const badExamples: string[] = [];
      RAW_CLASSES.forEach((entry, classIndex) => {
        const nodeRe = new RegExp("^" + entry.src + "$", "i");
        let tested = 0;
        let bad = 0;
        for (let d = 0; d < CP; d++) {
          if (isSurrogate(d)) continue;
          tested++;
          const actual = ex.runClassTest(classIndex, d) === 1;
          const expected = nodeRe.test(String.fromCharCode(d));
          if (actual !== expected) {
            bad++;
            if (badExamples.length < 20) badExamples.push(`${entry.src} U+${d.toString(16)}: exec=${actual} node=${expected}`);
          }
        }
        expect(tested, `${entry.src} must sweep the full non-surrogate BMP`).toBe(63_488);
        totalTested += tested;
        totalBad += bad;
      });
      expect(totalBad, badExamples.join("\n")).toBe(0);
      expect(totalTested, "class-sweep pair count must match design §6.2's own measured figure").toBe(571_392);
    },
    120_000,
  );

  // BRIDGE SPOT-CHECKS (lead's rider on the sweeps-plan message): the
  // header comment's claim that a hand-built blob "is EXACTLY what
  // assemble() would itself emit" was argued from reading emitTestChar/
  // emitRangeTest — this makes it MEASURED instead, byte-diffing
  // assemble()'s REAL output for a real /x/i and /[...]/i pattern
  // against this file's own hand-built construction for the identical
  // case, so the sweep's operand construction rests on the same kind of
  // evidence as everything else in this pass, not a parallel derivation.
  const BRIDGE_FLAGS: AssembleFlags = { global: false, ignoreCase: true, multiLine: false, dotAll: false, unicode: false, sticky: true };

  test("BRIDGE 1 (char): assemble()'s real bytecode for /a/i (sticky) is byte-identical to this file's hand-built save_start/char_i(canonicalize('a'))/save_end/match blob", () => {
    const parsed = parsePattern("a", 0, false, true, false, false);
    expect(parsed, "parse must succeed").not.toBeNull();
    const asm = assemble(parsed!.ast, BRIDGE_FLAGS);
    const patternVal = canonicalize("a".charCodeAt(0));
    const w = new RegexByteWriter();
    w.u8(0x22); // STICKY(0x20) | IGNORECASE(0x02)
    w.u8(0x00);
    w.u8(1);
    w.u8(0);
    const bodyLenPos = w.size;
    w.u32(0);
    const bodyStart = w.size;
    w.u8(19);
    w.u8(0);
    w.u8(2); // REOP.char_i
    w.u16(patternVal);
    w.u8(20);
    w.u8(0);
    w.u8(16);
    w.patchU32(bodyLenPos, w.size - bodyStart);
    expect(Array.from(asm.bytes), "assemble()'s real /a/i bytecode vs the hand-built blob").toEqual(Array.from(w.toBytes()));
  });

  test("BRIDGE 2 (class): assemble()'s real bytecode for /[a-z]/i (sticky) is byte-identical to this file's hand-built save_start/range_i(caseCloseClass([a-z]))/save_end/match blob", () => {
    const parsed = parsePattern("[a-z]", 0, false, true, false, false);
    expect(parsed, "parse must succeed").not.toBeNull();
    const asm = assemble(parsed!.ast, BRIDGE_FLAGS);
    const expectedBytes = buildClassBytecode(RAW_CLASSES[0]!); // [a-z], non-negated
    expect(Array.from(asm.bytes), "assemble()'s real /[a-z]/i bytecode vs the hand-built blob").toEqual(Array.from(expectedBytes));
  });
});
