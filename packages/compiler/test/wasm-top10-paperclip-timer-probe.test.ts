/* paperclip step 8: the defensive unref probe on a timer handle.
 * paperclip's telemetry client arms a flush timer and detaches it:
 * `if (typeof timer === "object" && timer !== null && "unref" in timer)
 * timer.unref();`. The handle is an object in Node; scriptc represents it
 * by its numeric timer id, so `typeof timer` folded to "number" — a
 * SILENT divergence (the probe failed and the timer kept the process
 * alive) — and `"unref" in timer` fenced. A Timeout/Immediate handle now
 * answers typeof "object", and `in` answers true for its own methods (ref,
 * unref, hasRef, and refresh/close on a Timeout); other names fence.
 * Rows run under Node and on both WasmGC lanes (with @types/node). */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-timer-probe");

const ROWS: Row[] = [
  {
    id: "PC8-01 typeof and the unref probe on a Timeout",
    files: {
      "main.ts": `let flushed = 0;
function schedule(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => { flushed += 1; console.log("flush", flushed); }, 1000);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
    console.log("detached");
  }
  return timer;
}
const t = schedule();
console.log(typeof t, typeof setTimeout(() => {}, 0), "ref" in t, "hasRef" in t, t.hasRef());`,
    },
  },
  {
    id: "PC8-02 an Immediate handle",
    files: {
      "main.ts": `const im = setImmediate(() => console.log("immediate ran"));
console.log(typeof im, "unref" in im, "ref" in im);`,
    },
  },
];

describe("paperclip: the timer unref probe (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: the timer unref probe (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: other names on a timer handle keep the fence", () => {
  test("PC8-R1 '_idleTimeout' in a Timeout", async () => {
    await checkRefuses(scratch, {
      id: "PC8-R1",
      files: { "main.ts": `const t = setTimeout(() => {}, 1);\nconsole.log("_idleTimeout" in t);\nclearTimeout(t);` },
    }, "on a timer handle");
  });
});
