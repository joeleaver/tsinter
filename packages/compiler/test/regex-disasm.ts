/* INC-24 P1, CP4: a REAL disassembler for this port's own regex
 * bytecode — walks opcode-by-opcode using REOP_SIZE (plus the
 * variable-length operand rules for range/range32(_i) and
 * back_reference/backward_back_reference(_i)), never a byte-value scan.
 *
 * Built after a reachability-probe mistake during the anchor-family
 * sub-unit (findings-p1-v1.txt): `bytes.includes(REOP.line_start)`
 * returned `true` for EVERY pattern tried, including anchor-free ones,
 * because a small opcode VALUE coincidentally collides with SOME
 * operand byte elsewhere in nearly any nontrivial bytecode stream —
 * `.includes()` has no notion of "opcode position" vs "operand
 * position". A suspiciously UNIFORM reachability signal from that
 * technique is the standing tell now: don't trust it, disassemble —
 * this file is the durable instrument for that, so the next probe
 * doesn't re-derive (or re-skip) the same walk ad hoc in a throwaway
 * shell one-liner. No test-runner dependency (regex-corpus.ts's own
 * convention) — importable from a probe script, a test file, or a
 * future gate/review tool alike. */
import { REOP, REOP_SIZE, RE_HEADER_LEN } from "../src/backend/wasm/regex-opcodes.js";

const OPCODE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(REOP).map(([name, value]) => [value, name]));

/** disassemble(bytes) -> the opcode NAMES in emission order, skipping
 * the 8-byte header (RE_HEADER_LEN) and the named-groups trailer (if
 * any — this walk stops once it reaches bytecode_length worth of body,
 * matching RE_HEADER_BYTECODE_LEN's own boundary, not `bytes.length`,
 * so a trailer's own bytes are never misread as more opcodes). An
 * unrecognized opcode byte renders as `?<value>` rather than throwing
 * — a disassembler is a DIAGNOSTIC tool; refusing to show the rest of
 * a stream because one byte is unexpected would defeat its own
 * purpose (compare exec()'s own `unreachable()` refusal, which is
 * correct for the INTERPRETER but wrong for something meant to be read
 * by a human debugging a probe). */
export function disassemble(bytes: Uint8Array, bodyLength?: number): string[] {
  const end = bodyLength === undefined ? bytes.length : RE_HEADER_LEN + bodyLength;
  const out: string[] = [];
  let pos = RE_HEADER_LEN;
  while (pos < end) {
    const op = bytes[pos]!;
    const name = OPCODE_NAMES[op] ?? `?${op}`;
    out.push(name);
    const size = REOP_SIZE[op] ?? 1;
    if (op === REOP.range || op === REOP.range_i) {
      const n = bytes[pos + 1]! | (bytes[pos + 2]! << 8);
      pos += size + 4 * n;
    } else if (op === REOP.range32 || op === REOP.range32_i) {
      const n = bytes[pos + 1]! | (bytes[pos + 2]! << 8);
      pos += size + 8 * n;
    } else if (op === REOP.back_reference || op === REOP.back_reference_i || op === REOP.backward_back_reference || op === REOP.backward_back_reference_i) {
      const n = bytes[pos + 1]!;
      pos += size + n;
    } else {
      pos += size;
    }
  }
  return out;
}
