/* paperclip step 6: array methods on `as const` tuples. paperclip's
 * shared constants are readonly tuples of string literals
 * (`export const INBOX_MINE_ISSUE_STATUSES = ["backlog", ...] as const`)
 * joined, searched and mapped at module load:
 * `INBOX_MINE_ISSUE_STATUSES.join(",")`. A READONLY tuple whose positions
 * share one IR type now runs the non-mutating array methods on a fresh
 * array copy of its positions (join, includes, indexOf, at, slice,
 * concat with side-effect-free arguments, and the callback methods with
 * an inline arrow that does not declare the array parameter). Nothing can
 * write a readonly tuple between the copy and the reads; a MUTABLE tuple
 * keeps its own live lowerings (PC6-03, GH #117's f22-f24).
 * Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-tuple-methods");

const ROWS: Row[] = [
  {
    id: "PC6-01 join, includes, indexOf on a string-literal tuple",
    files: {
      "main.ts": `export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as const;
export type Status = (typeof STATUSES)[number];
export const FILTER = STATUSES.join(",");
function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}
function rank(s: Status): number { return STATUSES.indexOf(s); }
console.log(FILTER, STATUSES.join(), isStatus("todo"), isStatus("nope"), rank("blocked"), STATUSES.includes("done"));
console.log(STATUSES.at(-1), STATUSES.slice(1, 3).join("|"), STATUSES.concat(["done"]).length);`,
    },
  },
  {
    id: "PC6-03 a mutable tuple written by its own callback keeps its live reads",
    files: {
      "main.ts": `const t: [number, number] = [1, 2];
console.log(t.map((v) => { t[1] = 9; return v; }), t.slice(0).join(","));`,
    },
  },
  {
    id: "PC6-02 callback methods with inline arrows",
    files: {
      "main.ts": `const KINDS = ["agent", "project", "goal"] as const;
const LABELS = KINDS.map((k) => k.toUpperCase());
const long = KINDS.filter((k, i) => k.length > 4 || i === 0);
const total = KINDS.reduce((n, k) => n + k.length, 0);
console.log(LABELS.join(","), long.join(","), total, KINDS.some((k) => k === "goal"), KINDS.every((k) => k.length > 3));
console.log(KINDS.find((k) => k.startsWith("p")), KINDS.findIndex((k) => k === "goal"));
KINDS.forEach((k, i) => console.log(i, k));
const PORTS = [3100, 3101, 5432] as const;
console.log(PORTS.join(":"), PORTS.map((p) => p + 1).join(" "), PORTS.includes(5432));`,
    },
  },
];

describe("paperclip: array methods on as-const tuples (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: array methods on as-const tuples (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
