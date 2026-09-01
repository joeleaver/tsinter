/* INC-24 P1, CP3: drift check for regex-opcodes.ts's REOP/REOP_SIZE
 * against the vendored libregexp-opcode.h — this is DATA (opcode values
 * ARE the byte encoding), so there is no algorithm to re-derive; the
 * check is a direct re-parse-and-compare of the live header, independent
 * of the hand-transcription in regex-opcodes.ts, mirroring
 * wasm-casing-tables-drift.test.ts's own discipline for vendored data. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { REOP, REOP_SIZE } from "../src/backend/wasm/regex-opcodes.js";

function parseReference(): { names: string[]; sizes: number[] } {
  const header = readFileSync("packages/runtime/vendor/quickjs-ng/libregexp-opcode.h", "utf8");
  const defs = [...header.matchAll(/^DEF\(([a-z0-9_]+),\s*(\d+)\)/gm)];
  return { names: defs.map((m) => m[1]!), sizes: defs.map((m) => Number(m[2])) };
}

describe("regex-opcodes.ts drift check", () => {
  test("REOP's names and values match the live header, in order, exactly", () => {
    const { names } = parseReference();
    const myEntries = Object.entries(REOP).sort((a, b) => a[1] - b[1]);
    expect(myEntries.length).toBe(names.length);
    for (let i = 0; i < names.length; i++) {
      expect(myEntries[i]![0], `index ${i}`).toBe(names[i]);
      expect(myEntries[i]![1], `index ${i}`).toBe(i);
    }
  });

  test("REOP_SIZE matches the live header's DEF(...) size column, in order", () => {
    const { sizes } = parseReference();
    expect(REOP_SIZE.length).toBe(sizes.length);
    expect([...REOP_SIZE]).toEqual(sizes);
  });

  test("REOP is a dense 0..N-1 enumeration with no gaps or duplicates", () => {
    const values = Object.values(REOP).sort((a, b) => a - b);
    for (let i = 0; i < values.length; i++) expect(values[i]).toBe(i);
  });
});
