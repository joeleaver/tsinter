/* paperclip step 4: writeFileSync with the flag option. paperclip's
 * install store and lock files write with `{ mode: 0o600, flag: "wx" }`
 * (exclusive create: a second writer gets EEXIST) and atomic temp files
 * with `{ mode, flag: "wx" }`. flag "w" (Node's default) and "wx" now
 * lower; "wx" is open(2)'s O_CREAT|O_EXCL through op 9's exclusive bit.
 * Other flags keep the named fence.
 *
 * The rows touch the file system, so they run on the wasm-native lane
 * (the in-process wasm host's fsCall is a loud stub by design: see
 * wasm-host.ts); the build and the refusals are checked on the wasm lane
 * too. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-write-flag");

const PRELUDE = `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc4-"));`;
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, esModuleInterop: true } });

const ROWS: Row[] = [
  {
    id: "PC4-01 an exclusive create, then EEXIST on the second writer",
    files: {
      "tsconfig.json": TSCONFIG,
      "main.ts": `${PRELUDE}
const lock = path.join(dir, "lock");
fs.writeFileSync(lock, "one\\n", { mode: 0o600, flag: "wx" });
try {
  fs.writeFileSync(lock, "two\\n", { mode: 0o600, flag: "wx" });
  console.log("second write succeeded");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("second:", err.code, err.message === "EEXIST: file already exists, open '" + lock + "'");
}
console.log(fs.readFileSync(lock, "utf8").trim());
fs.rmSync(dir, { recursive: true, force: true });`,
    },
  },
  {
    id: "PC4-02 flag wx without a mode, and flag w (the default) truncates",
    files: {
      "tsconfig.json": TSCONFIG,
      "main.ts": `${PRELUDE}
const tmp = path.join(dir, "store.json.tmp");
const contents = JSON.stringify({ version: "1.0.0" }) + "\\n";
fs.writeFileSync(tmp, contents, { flag: "wx" });
fs.writeFileSync(tmp, "short\\n", { encoding: "utf8", flag: "w" });
console.log(JSON.stringify(fs.readFileSync(tmp, "utf8")));
let failed = "";
try {
  fs.writeFileSync(tmp, contents, { flag: "wx" });
} catch (e) {
  failed = (e as NodeJS.ErrnoException).code ?? "";
}
console.log(failed);
fs.rmSync(dir, { recursive: true, force: true });`,
    },
  },
];

describe("paperclip: writeFileSync flag 'wx' (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: writeFileSync flags outside w/wx keep the named fence", () => {
  test.for([["PC4-R1 flag a", "a"], ["PC4-R2 flag ax", "ax"], ["PC4-R3 flag r+", "r+"]] as const)("%s", async ([id, flag]) => {
    await checkRefuses(scratch, {
      id,
      files: {
        "tsconfig.json": TSCONFIG,
        "main.ts": `import fs from "node:fs";\nfs.writeFileSync("/tmp/x", "y", { flag: "${flag}" });`,
      },
    }, "writeFileSync with the flag option");
  });
});
