import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_process_tail");
const cliBin = join(testDir, "../../cli/dist/main.js");
const umaskCase = join(testDir, "process-tail-umask-case.ts");

// Compiles the C-side oracle test once (path.test.ts's own shape). Built
// with ASan + the RC audit so the oracle run also proves scr_process_kill/
// scr_process_chdir/scr_process_umask/scr_process_umask_read's own error
// paths (ScrError allocation + release via scr_exc_clear) neither leak nor
// double-free.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11", "-O1", "-Wall", "-Wextra",
    "-fsanitize=address", "-DSCR_RC_AUDIT",
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
    "-I", join(testDir, "../src"),
    "-o", bin,
    join(testDir, "test_process_tail.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bytes.c"),
    ...(process.platform === "linux" ? ["-lm"] : []),
  ]);
});

// Runs against the committed case file (generated from Node v24 via
// gen-process-tail-cases.mjs — see that file to regenerate): board #143's
// three C-lane fixes — R-A scr_process_chdir's two-path error, R-B
// scr_process_kill's numeric signal gate (0/-0 probe, an in-range integer
// passes raw, NaN defaults to SIGTERM, anything else throws Node's own
// ERR_UNKNOWN_SIGNAL TypeError), R-C scr_process_umask's INTEGER-FIRST
// then RANGE-SECOND RangeError validation plus its own separated read
// form (scr_process_umask_read) — against Node's own measured answers.
test("process-tail (chdir/kill/umask) C-lane fixes match Node on committed oracle cases", async () => {
  const { stderr } = await execFileAsync(bin, [join(testDir, "process-tail-cases.txt")]);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// M-27 (POST-ACK #17, delta-3eb 4db75f2c): the direct C-call cases above
// could never have reddened the MAY_THROW_LIB_FNS gap this pass found —
// scr_process_umask's own validation was always correct; only a COMPILED
// call site skips the post-call pending-exception check when its own
// IrLibFn name is absent from that set (packages/compiler/src/ir/nodes.ts).
// This row calls it through an ACTUAL COMPILED PROGRAM on BOTH native
// lanes (llvm default, --backend c) — process-tail-umask-case.ts, whose
// two invalid-mask cases (1.5, -1) are the SAME masks process-tail-
// cases.txt's own "umask-invalid" rows already cover; the expected output
// is built from THOSE rows directly (never a second hand-typed copy), so
// there is exactly one place in this repo asserting what Node says for
// mask 1.5 and mask -1.
test("process.umask's validation is observable through a COMPILED program on both native lanes (M-27)", async () => {
  const casesText = await readFile(join(testDir, "process-tail-cases.txt"), "utf8");
  const rows = new Map<string, string>();
  for (const line of casesText.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] === "umask-invalid") rows.set(fields[1]!, fields[4]!);
  }
  const msg15 = rows.get("1.5");
  const msgNeg1 = rows.get("-1");
  if (msg15 === undefined || msgNeg1 === undefined) {
    throw new Error("process-tail-cases.txt is missing its umask-invalid 1.5/-1 rows");
  }
  const expected = [`caught: ${msg15}`, `caught2: ${msgNeg1}`, ""].join("\n");
  for (const backendArgs of [["run", umaskCase], ["run", umaskCase, "--backend", "c"]]) {
    const { stdout } = await execFileAsync(process.execPath, [cliBin, ...backendArgs]);
    expect(stdout).toBe(expected);
  }
});
