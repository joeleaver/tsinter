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
 * impractical). For ignoreCase, the PATTERN side is already
 * Canonicalize()'d (char) / case-closed (class) at compile time — VAL
 * (or the range table) is read RAW from bytecode by emitTestChar/
 * emitRangeTest and compared against regexCanonicalize(subjectChar),
 * never canonicalized itself at match time. So the char sweep hand-
 * builds a blob with regex-canon.ts's canonicalize() as the pattern-side
 * operand — exactly what the regex compiler emits for /x/i, MEASURED by
 * BRIDGE 1 below (byte-diffing the compiler's real /a/iy) — and the
 * class sweep runs the compiler's OWN bytecode for each class under /iy,
 * so it measures the compiler's case closure and exec()'s range_i
 * dispatch together against Node.
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
 * ALWAYS precomputed in JS via canonicalize(c), matching what the
 * compiler embeds.
 *
 * runClassTest(classIndex, subjectCp): runs the compiler's own /iy
 * bytecode for one of 9 FIXED classes (save_start(0)/range_i(table)/
 * save_end(0)/match, embedded once at module-build time).
 */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { canonicalize } from "../src/backend/wasm/regex-canon.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";
import { compiled } from "./regex-compile.js";

const CP = 0x10000;
const isSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdfff;

interface SweepExports {
  runCharITest: (patternVal: number, subjectCp: number) => number;
  runClassTest: (classIndex: number, subjectCp: number) => number;
}

const RAW_CLASSES: Array<{ src: string }> = [
  { src: "[a-z]" },
  { src: "[A-Z]" },
  { src: "[a-f]" },
  { src: "[^a-z]" },
  { src: "[aeiou]" },
  { src: "[^aeiou]" },
  { src: "[\\u00c0-\\u00ff]" },
  { src: "[\\u0100-\\u017f]" },
  { src: "[\\u0391-\\u03a9]" },
];

/** Full REOP_range_i bytecode for one class: the one regex compiler's own
 * output for the class under /iy (its case closure — each member closed,
 * a `[^...]` inverted after — is what this sweep measures against Node,
 * together with exec()'s own range_i dispatch). */
function buildClassBytecode(entry: (typeof RAW_CLASSES)[number]): Uint8Array {
  return compiled(entry.src, "iy").bytes;
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

  // BRIDGE SPOT-CHECK (lead's rider on the sweeps-plan message): the
  // char sweep's hand-built blob "is EXACTLY what the compiler would
  // itself emit" — MEASURED, byte-diffing the compiler's REAL output for
  // /a/iy against this file's own construction for the identical case.
  // (The class sweep runs the compiler's own bytecode, so it needs no
  // bridge.)
  test("BRIDGE 1 (char): the compiler's real bytecode for /a/i (sticky) is byte-identical to this file's hand-built save_start/char_i(canonicalize('a'))/save_end/match blob", () => {
    const patternVal = canonicalize("a".charCodeAt(0));
    // header: flags STICKY(0x20)|IGNORECASE(0x02) (u16), captureCount 1,
    // registerCount 0, body length (u32); body: save_start 0, char_i,
    // save_end 0, match
    const body = [19, 0, 2, patternVal & 0xff, patternVal >> 8, 20, 0, 16];
    const blob = [0x22, 0x00, 1, 0, body.length, 0, 0, 0, ...body];
    expect(Array.from(compiled("a", "iy").bytes), "the compiler's real /a/i bytecode vs the hand-built blob").toEqual(blob);
  });
});
