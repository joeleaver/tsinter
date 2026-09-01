/* INC-24 P1, CP4 back half: the NON-STICKY SEARCH-LOOP PRELUDE, through
 * real exec() end to end — a gap the lead's own review surfaced before
 * value-struct+embedding: every existing exec() test (CASES, the
 * 3,000-pair corpus) forces AssembleFlags.sticky=true unconditionally,
 * so the prelude regex-assembler.ts:716-723 emits for a NON-sticky
 * pattern (libregexp.c:2564-2568's own split_goto_first/any/goto loop
 * — "try here, else consume one char and retry the whole atom from the
 * next position") has never been run through the interpreter, only
 * byte-verified against lre_compile (wasm-regex-assembler-corpus.test.ts,
 * which DOES vary sticky from the real flag string — `sticky:
 * flagStr.includes("y")`).
 *
 * regex-interpreter.ts NEVER reads RE_HEADER's own STICKY bit (grep
 * confirms zero hits) — sticky-vs-search is entirely a BYTECODE-SHAPE
 * decision the ASSEMBLER makes (emit the prelude or don't); exec() is
 * a generic interpreter that runs whatever opcodes it's given. The
 * prelude's three opcodes (split_goto_first, any, goto) were all built
 * and pinned individually early in CP4, well before "the interpreter's
 * own opcode set is now complete" — so this file's job is proving the
 * ALREADY-BUILT pieces compose correctly for this specific shape, not
 * building anything new.
 *
 * THE THREE SHAPES the lead named: a match found at index>0 (the
 * prelude's own advancing is what finds it), no match anywhere in the
 * subject (the prelude exhausts every position), and first-match-wins
 * (the prelude must stop at the FIRST position that matches, not scan
 * past it). Compared against Node's own non-sticky/global search
 * (new RegExp(pattern, flags+"g"), lastIndex=startIndex, .exec()) —
 * the correct oracle for "search from startIndex" semantics, per
 * design §3.1's own operation surface (search/test/match/... are ALL
 * non-sticky search operations; there is no exec() in the design's own
 * ten methods — re.exec(s) lowers to match).
 */
import { describe, expect, test } from "vitest";
import { Code } from "../src/backend/wasm/code.js";
import { I32, ModuleBuilder, type ValType } from "../src/backend/wasm/module.js";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { RE_HEADER_REGISTER_COUNT } from "../src/backend/wasm/regex-opcodes.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { RegexInterpreterBuilder } from "../src/backend/wasm/regex-interpreter.js";

interface Case {
  pattern: string;
  subject: string;
  startIndex: number;
  ignoreCase?: boolean;
}

const CASES: Case[] = [
  // Shape 1: match found at index>0 ONLY via the prelude's own advancing
  // (sticky-at-0 would fail; the pattern is nowhere NEAR the start).
  { pattern: "b", subject: "aaab", startIndex: 0 },
  { pattern: "cd", subject: "xxxxxcd", startIndex: 0 },
  { pattern: "a+b", subject: "xxxaaab", startIndex: 0 },
  // startIndex itself nonzero: the prelude must start its OWN search
  // there, not at 0 (mirrors Node's lastIndex-driven search start).
  { pattern: "b", subject: "babab", startIndex: 2 },

  // Shape 2: no match anywhere — the prelude must exhaust EVERY
  // position (including subject.length itself, for a zero-width-
  // capable pattern) and correctly report failure, not hang or
  // false-positive.
  { pattern: "z", subject: "aaaa", startIndex: 0 },
  { pattern: "xyz", subject: "abcdef", startIndex: 0 },
  { pattern: "a", subject: "", startIndex: 0 },

  // Shape 3: first-match-wins — the prelude must stop at the FIRST
  // position a match starts, not scan past it to a later, ALSO-
  // matching position (a pattern present at MULTIPLE positions).
  { pattern: "a", subject: "xaxaxa", startIndex: 0 },
  { pattern: "ab", subject: "ababab", startIndex: 0 },
  { pattern: "a", subject: "xaxaxa", startIndex: 2 }, // first-match-wins FROM startIndex=2, not from 0

  // A capturing group through the prelude (save_start/save_end must
  // report the ACTUAL match position the prelude landed on, not 0).
  { pattern: "(b+)c", subject: "xxbbbc", startIndex: 0 },
  // ignoreCase through the prelude (char_i inside a non-sticky body).
  { pattern: "B", subject: "xxxb", startIndex: 0, ignoreCase: true },
];

function flagsFor(tc: Case): AssembleFlags {
  return { global: false, ignoreCase: !!tc.ignoreCase, multiLine: false, dotAll: false, unicode: false, sticky: false };
}

interface ExecExports {
  exec: (bc: unknown, subject: unknown, startIndex: number, captureOut: unknown) => number;
  newCaptureArray: (count: number) => unknown;
  capAt: (arr: unknown, i: number) => number;
  bcLit: (i: number) => unknown;
  subjLit: (i: number) => unknown;
}

async function build(): Promise<ExecExports> {
  const mb = new ModuleBuilder();
  const strType = mb.arrayType("i16", true);
  const strRef: ValType = { kind: "ref", nullable: true, typeIndex: strType };
  const bcType = mb.arrayType("i8", false);
  const bcRef: ValType = { kind: "ref", nullable: true, typeIndex: bcType };
  const capType = mb.arrayType(I32, true);
  const capRef: ValType = { kind: "ref", nullable: true, typeIndex: capType };
  const interp = new RegexInterpreterBuilder(mb, strType);

  const strUnits = (s: string): Uint8Array => {
    const units = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      units[i * 2] = u & 0xff;
      units[i * 2 + 1] = u >> 8;
    }
    return units;
  };

  const bcLitFn = mb.declareFunc(mb.funcType([I32], [bcRef]), "bcLit");
  {
    const c = new Code();
    CASES.forEach((tc, i) => {
      const flags = flagsFor(tc);
      const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
      if (parsed === null || parsed.next !== tc.pattern.length) throw new Error(`parse failed for /${tc.pattern}/`);
      const asm = assemble(parsed.ast, flags);
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const off = mb.internData(asm.bytes);
      c.i32Const(off);
      c.i32Const(asm.bytes.length);
      c.arrayNewData(bcType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(bcLitFn, [], c.bytes());
  }

  const subjLitFn = mb.declareFunc(mb.funcType([I32], [strRef]), "subjLit");
  {
    const c = new Code();
    CASES.forEach((tc, i) => {
      c.localGet(0);
      c.i32Const(i);
      c.i32Eq();
      c.ifVoid();
      const units = strUnits(tc.subject);
      const off = mb.internData(units);
      c.i32Const(off);
      c.i32Const(tc.subject.length);
      c.arrayNewData(strType, 0);
      c.return_();
      c.end();
    });
    c.unreachable();
    mb.setBody(subjLitFn, [], c.bytes());
  }

  const capAtFn = mb.declareFunc(mb.funcType([capRef, I32], [I32]), "capAt");
  {
    const c = new Code();
    c.localGet(0);
    c.localGet(1);
    c.arrayGet(capType);
    mb.setBody(capAtFn, [], c.bytes());
  }

  mb.exportFunc("bcLit", bcLitFn);
  mb.exportFunc("subjLit", subjLitFn);
  mb.exportFunc("capAt", capAtFn);
  mb.exportFunc("newCaptureArray", interp.newCaptureArray());
  mb.exportFunc("exec", interp.exec());

  const bytes = mb.emit();
  try {
    new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`nonsticky-prelude module failed to validate: ${(e as Error).message}`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as ExecExports;
}

function captureCountFor(tc: Case): number {
  const flags = flagsFor(tc);
  const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll)!;
  return assemble(parsed.ast, flags).captureCount;
}

function captureArrayCountFor(tc: Case): number {
  const flags = flagsFor(tc);
  const parsed = parsePattern(tc.pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll)!;
  const asm = assemble(parsed.ast, flags);
  const registerCount = asm.bytes[RE_HEADER_REGISTER_COUNT]!;
  return asm.captureCount + Math.ceil(registerCount / 2);
}

describe("%w.re.exec, NON-STICKY (the search-loop prelude, real bytecode, real exec())", () => {
  test.each(CASES)("/$pattern/ on $subject @ $startIndex (non-sticky)", async (tc) => {
    const ex = await build();
    const i = CASES.indexOf(tc);
    const flagStr = tc.ignoreCase ? "ig" : "g"; // NODE oracle: non-sticky search from startIndex == a global regex with lastIndex set
    const nodeRe = new RegExp(tc.pattern, flagStr);
    nodeRe.lastIndex = tc.startIndex;
    const nodeMatch = nodeRe.exec(tc.subject);

    const bc = ex.bcLit(i);
    const subj = ex.subjLit(i);
    const captureCount = captureCountFor(tc);
    const captureOut = ex.newCaptureArray(captureArrayCountFor(tc));
    const result = ex.exec(bc, subj, tc.startIndex, captureOut);

    if (nodeMatch === null) {
      expect(result, `expected no match for /${tc.pattern}/ (search) on ${JSON.stringify(tc.subject)}@${tc.startIndex}`).toBe(0);
    } else {
      expect(result, `expected a match for /${tc.pattern}/ (search) on ${JSON.stringify(tc.subject)}@${tc.startIndex}`).toBe(1);
      const start = ex.capAt(captureOut, 0);
      const end = ex.capAt(captureOut, 1);
      expect(start, "match start — the prelude's OWN found position, not startIndex").toBe(nodeMatch.index);
      expect(end - start, "capture 0 length").toBe(nodeMatch[0].length);
      for (let g = 1; g < captureCount; g++) {
        const gStart = ex.capAt(captureOut, 2 * g);
        const gEnd = ex.capAt(captureOut, 2 * g + 1);
        if (nodeMatch[g] === undefined) {
          expect(gStart, `capture ${g} should be unset`).toBe(-1);
          expect(gEnd, `capture ${g} should be unset`).toBe(-1);
        } else {
          expect(gEnd - gStart, `capture ${g} length`).toBe(nodeMatch[g]!.length);
        }
      }
    }
  });
});
