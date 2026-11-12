/* deepseek step 2: `new Date(x).getTimezoneOffset()`, composed. cosmokit
 * (deepseek's vendored utility package) reads
 * `let timezoneOffset = new Date().getTimezoneOffset()` at module load. The
 * Date value between the two calls never materializes (the toISOString /
 * getTime precedent); the answer is the host zone's offset at the instant
 * (S113's tzCall OFFSET on the WasmGC lanes), minutes west of UTC with
 * V8's integer truncation, NaN for an invalid date. Rows pin zones through
 * `process.env.TZ` (Node re-reads its zone), so they hold on any host.
 * Synthetic rows written from reading the project; each runs under Node and
 * on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("ds-tz-offset");

const ROWS: Row[] = [
  {
    id: "DS2-01 the host zone now, and cosmokit's module-load shape",
    files: {
      "time.ts": `export const minute = 60000;
let timezoneOffset = new Date().getTimezoneOffset();
export function getTimezoneOffset(): number {
  return timezoneOffset;
}
export function getDateNumber(ms: number): number {
  return Math.floor((ms / minute - timezoneOffset) / 1440);
}`,
      "main.ts": `import { getTimezoneOffset, getDateNumber } from "./time.ts";
const now = new Date().getTimezoneOffset();
console.log(getTimezoneOffset() === now, Number.isInteger(now), typeof now);
console.log(getDateNumber(Date.UTC(2024, 0, 15, 12)) - Math.floor(Date.UTC(2024, 0, 15, 12) / 86400000) <= 1);`,
    },
  },
  {
    id: "DS2-02 fixed instants across zones, DST, half- and quarter-hour zones, local mean time (truncated minutes), UTC (no -0), invalid dates",
    files: {
      "main.ts": `const instants = [Date.UTC(2024, 0, 15), Date.UTC(2024, 6, 15), Date.UTC(1990, 2, 25, 1, 30), Date.UTC(1880, 0, 1)];
for (const tz of ["UTC", "America/Chicago", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "Europe/London"]) {
  process.env.TZ = tz;
  const offs = instants.map((ms) => new Date(ms).getTimezoneOffset());
  console.log(tz, offs.join(","), Object.is(new Date(instants[0]!).getTimezoneOffset(), -0));
}
process.env.TZ = "America/New_York";
console.log(new Date("2024-07-04T12:00:00Z").getTimezoneOffset(), new Date("2024-01-04").getTimezoneOffset());
console.log(new Date(NaN).getTimezoneOffset(), new Date(8.64e15 + 1).getTimezoneOffset(), new Date("nonsense").getTimezoneOffset());`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`deepseek step 2: getTimezoneOffset (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}
