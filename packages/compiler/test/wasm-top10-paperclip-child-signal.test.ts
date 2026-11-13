/* paperclip step 12: ChildProcess.signalCode and once("exit"). paperclip's
 * runtime command cancels a child with
 * `if (child.exitCode === null && child.signalCode === null)
 * child.kill("SIGTERM")`; its worker waits with `child.once("exit", ...)`.
 * signalCode is now the terminating signal's name once a signal death was
 * delivered, null otherwise (Node sets it in the same exit handling that
 * fires 'exit'). once("exit") registers the same listener as on("exit"):
 * 'exit' is delivered at most once per child. once("error") keeps a named
 * fence ('error' can fire once per failed kill). The rows spawn real
 * processes, so they run on the wasm-native lane (the in-process wasm
 * host has no child host); the refusal is checked on the wasm lane. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-child-signal");

const ROWS: Row[] = [
  {
    id: "PC12-01 signalCode before, after a code exit and after a signal death; once('exit')",
    files: {
      "main.ts": `import { spawn } from "node:child_process";
const a = spawn("sh", ["-c", "exit 3"], { stdio: "ignore" });
console.log("running", a.exitCode, a.signalCode);
a.once("exit", (code, signal) => {
  console.log("a exit", code, signal, a.exitCode, a.signalCode);
  const b = spawn("sleep", ["5"], { stdio: "ignore" });
  const cancel = (): void => { if (b.exitCode === null && b.signalCode === null) b.kill("SIGTERM"); };
  b.once("exit", (code2, signal2) => {
    console.log("b exit", code2, signal2, b.exitCode, b.signalCode);
    cancel();
    console.log("cancel again is a no-op", b.killed);
  });
  cancel();
});`,
    },
  },
];

describe("paperclip: ChildProcess.signalCode and once('exit') (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("paperclip: once('error') keeps the fence", () => {
  test("PC12-R1 child.once('error', ...)", async () => {
    await checkRefuses(scratch, {
      id: "PC12-R1",
      files: { "main.ts": `import { spawn } from "node:child_process";\nconst c = spawn("true", [], { stdio: "ignore" });\nc.once("error", () => console.log("err"));` },
    }, 'child.once("error", ...)');
  });
});
