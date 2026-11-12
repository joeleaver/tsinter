/* paperclip step 5: process.getuid / process.getgid read as VALUES.
 * paperclip's install store probes the optional method before calling it:
 * `const getuid = process.getuid; if (typeof getuid === "function" &&
 * stat.uid !== getuid()) ...` (@types/node types it `getuid?: () =>
 * number`). Each member is now one interned zero-argument function,
 * referenced as a zero-capture closure: every read is the same function
 * (Node's identity: `process.getuid === process.getuid`) and calling it
 * is the member's own call. Rows run under Node and on both WasmGC lanes
 * (with @types/node). */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-getuid-value");

const ROWS: Row[] = [
  {
    id: "PC5-01 the probe-then-call idiom",
    files: {
      "main.ts": `function ownedByMe(uid: number): boolean {
  const getuid = process.getuid;
  if (typeof getuid === "function" && uid !== getuid()) return false;
  return true;
}
const me = process.getuid?.() ?? -1;
console.log(ownedByMe(me), ownedByMe(me + 12345), typeof process.getuid, typeof process.getgid);`,
    },
  },
  {
    id: "PC5-02 identity, storage and a detached call",
    files: {
      "main.ts": `const ids: { uid: (() => number) | undefined; gid: (() => number) | undefined } = { uid: process.getuid, gid: process.getgid };
console.log(process.getuid === process.getuid, ids.uid === process.getuid, ids.uid === ids.gid);
const uid = ids.uid;
const gid = ids.gid;
if (uid !== undefined && gid !== undefined) {
  console.log(uid() === process.getuid!(), gid() === process.getgid!(), uid() >= 0);
}`,
    },
  },
];

describe("paperclip: process.getuid as a value (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: process.getuid as a value (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
