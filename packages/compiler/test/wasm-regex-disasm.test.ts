/* INC-24 P1, CP4: regex-disasm.ts's own pins — a durable instrument
 * deserves direct verification too, not just trust because it "looks
 * right". Real patterns through this port's own already-byte-verified
 * assemble() (CP3), not hand-built bytecode: the point is confirming
 * the walker reads REAL emitted bytecode correctly, opcode names AND
 * variable-length skips both. */
import { describe, expect, test } from "vitest";
import { assemble, type AssembleFlags } from "../src/backend/wasm/regex-assembler.js";
import { parsePattern } from "../src/backend/wasm/regex-parser.js";
import { disassemble } from "./regex-disasm.js";

function disasmOf(pattern: string, flags: AssembleFlags): string[] {
  const parsed = parsePattern(pattern, 0, flags.unicode, flags.ignoreCase, flags.multiLine, flags.dotAll);
  if (parsed === null || parsed.next !== pattern.length) throw new Error(`parse failed for /${pattern}/`);
  const asm = assemble(parsed.ast, flags);
  return disassemble(asm.bytes);
}

const base: AssembleFlags = { global: false, ignoreCase: false, multiLine: false, dotAll: false, unicode: false, sticky: true };

describe("regex-disasm.ts: opcode-by-opcode walk (REOP_SIZE-driven, not a byte-value scan)", () => {
  test("a fixed-size-only pattern: every opcode name in emission order", () => {
    expect(disasmOf("^a", base)).toEqual(["save_start", "line_start", "char", "save_end", "match"]);
  });
  test("no false positive: an anchor-free pattern shows NO line_start/word_boundary anywhere — the exact mistake .includes() made", () => {
    const names = disasmOf("\\ba", base);
    expect(names).toContain("word_boundary");
    expect(names).not.toContain("line_start");
    expect(names).not.toContain("line_start_m");
    expect(names).not.toContain("line_end");
  });
  test("REOP_range's variable-length skip: the opcode AFTER a multi-range class is correctly identified, not misaligned into the middle of the range table", () => {
    // \d\d compiles TWO range instructions back to back — if the walker
    // mis-sized the first one's table, the second "range" would show up
    // as garbage (or the walk would desync entirely) instead of a clean
    // second "range".
    expect(disasmOf("\\d\\d", base)).toEqual(["save_start", "range", "range", "save_end", "match"]);
  });
  test("REOP_range32's variable-length skip: an astral class followed by a literal char is correctly identified, proving the 8-bytes-per-pair width is used (not range's own 4)", () => {
    const names = disasmOf("[\\u{10000}-\\u{10FFFF}]a", { ...base, unicode: true });
    expect(names).toEqual(["save_start", "range32", "char", "save_end", "match"]);
  });
});
