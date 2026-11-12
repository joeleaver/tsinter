/* paperclip step 7: the Number predicate statics over 'unknown' values.
 * paperclip validates a parsed runtime-info record field by field:
 * `!Number.isInteger(record.pid) || ...` with `record: Record<string,
 * unknown>`. The statics never coerce, so over a checked-dynamic value the
 * answer is "it is a number, and the predicate holds for it" — JS-exact
 * for every dynamic kind (strings, booleans, null, objects answer false).
 * Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-number-unknown");

const ROWS: Row[] = [
  {
    id: "PC7-01 Number.isInteger/isFinite/isNaN/isSafeInteger over parsed JSON fields",
    files: {
      "main.ts": `function validPid(raw: string): boolean {
  const record = JSON.parse(raw) as Record<string, unknown>;
  if (!Number.isInteger(record.pid) || typeof record.port !== "number") return false;
  return true;
}
console.log(validPid('{"pid": 42, "port": 3100}'), validPid('{"pid": 4.5, "port": 1}'), validPid('{"pid": "42", "port": 1}'), validPid('{"port": 1}'));
const values: unknown[] = JSON.parse('[1, 1.5, "2", true, null, {}, [], 9007199254740993, -0]') as unknown[];
for (const v of values) {
  console.log(JSON.stringify(v), Number.isInteger(v), Number.isFinite(v), Number.isNaN(v), Number.isSafeInteger(v));
}`,
    },
  },
];

describe("paperclip: Number statics over unknown (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: Number statics over unknown (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
