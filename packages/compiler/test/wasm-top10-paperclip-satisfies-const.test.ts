/* paperclip step 9: `{...} as const satisfies Record<string, number>`.
 * paperclip's telemetry retention table is declared
 * `export const RETENTION_DAYS = { operational_enum_count: 90 } as const
 * satisfies Record<string, number>;`. `lit satisfies T` already built the
 * literal at its OWN type (satisfies is type-level only), but the const
 * assertion between the two hid the satisfies: the literal was built at
 * the index-signature type and refused against the const's declared
 * record shape (SC2002). The own-type rule now looks through `as const`.
 * Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-satisfies-const");

const ROWS: Row[] = [
  {
    id: "PC9-01 a const-asserted record checked against Record<string, number>",
    files: {
      "main.ts": `export const RETENTION_DAYS = {
  operational_enum_count: 90,
  token_bearing: 30,
} as const satisfies Record<string, number>;
export type RetentionClass = keyof typeof RETENTION_DAYS;
function days(c: RetentionClass): number { return RETENTION_DAYS[c]; }
const LIMITS = { soft: 1, hard: 2 } as const satisfies Record<string, number>;
console.log(RETENTION_DAYS.operational_enum_count, days("token_bearing"), JSON.stringify(RETENTION_DAYS), LIMITS.hard - LIMITS.soft);`,
    },
  },
];

describe("paperclip: as const satisfies (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: as const satisfies (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
