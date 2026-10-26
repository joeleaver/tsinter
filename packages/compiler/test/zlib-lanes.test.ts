/* zlib, the same on every lane: ONE oracle table. Each program below runs
 * under live Node (v24.18.1, whose zlib is Chromium's fork "1.3.1-e00f703")
 * and compiled for every lane — wasm (backend/wasm/zlib.ts, the port) and
 * c and llvm (scr_zlib.c over packages/runtime/vendor/zlib-chromium, the
 * same upstream source, driven as Node drives it) — and every lane's stdout
 * must equal Node's byte for byte. The programs print deflateSync's bytes
 * (in full, or as a sha256 past 96 bytes) over every kind of input at every
 * boundary size, and inflateSync's outcome (output digest, or the thrown
 * Error's name, message and code) over hand-built error inputs, every
 * truncation of several streams, a byte flip at every offset of one, and
 * seeded mutation fuzz. Node's errno has no slot on any lane
 * (SEMANTICS.md S101 (a)), so no program prints it.
 *
 * wasm-zlib.test.ts holds the wasm port to Node in-process over a larger
 * input set; this table is what holds the LANES to each other. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const execFileAsync = promisify(execFile);

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-zlib-lanes-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const repoRoot = join(import.meta.dirname, "../../..");
const PROGRAMS: [string, string, (stdout: string) => void][] = [
  [
    "Z-LANES-01 corpus 1404-zlib-crypto-bytes.ts",
    join(repoRoot, "tests/corpus/1404-zlib-crypto-bytes.ts"),
    (out) => expect(out).toContain("corrupt incorrect header check\ntruncated unexpected end of file\n"),
  ],
  [
    "Z-LANES-02 corpus 2756-zlib-deflate-bytes.ts",
    join(repoRoot, "tests/corpus/2756-zlib-deflate-bytes.ts"),
    (out) => expect(out).toContain("hello 41 33 789ccb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b0146580fd9 rt\n"),
  ],
  [
    "Z-LANES-03 fixtures/zlib/deflate-bytes.ts: deflate bytes over every kind and boundary size",
    join(import.meta.dirname, "fixtures/zlib/deflate-bytes.ts"),
    (out) => expect(out.split("\n").length).toBeGreaterThan(200),
  ],
  [
    "Z-LANES-04 fixtures/zlib/inflate-errors.ts: every error row, truncation, byte flip and mutation",
    join(import.meta.dirname, "fixtures/zlib/inflate-errors.ts"),
    (out) => {
      expect(out.split("\n").length).toBeGreaterThan(2500);
      for (const m of ["Missing dictionary Z_NEED_DICT", "unexpected end of file Z_BUF_ERROR", "too many length or distance symbols Z_DATA_ERROR"]) {
        expect(out).toContain(m);
      }
    },
  ],
];

const LANES = ["wasm", "c", "llvm"] as const;
type Lane = (typeof LANES)[number];

async function runLane(file: string, lane: Lane): Promise<string> {
  const dir = await mkdtemp(join(scratch, `${lane}-`));
  const outPath = join(dir, lane === "wasm" ? "p.wasm" : "p");
  const res = await compile(file, { outPath, outDir: dir, backend: lane });
  if (!res.ok) throw new Error(`${lane} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  if (lane === "wasm") {
    const run = await runWasm(res.binaryPath);
    expect(run.stderr, `${lane} stderr`).toBe("");
    expect(run.exitCode, `${lane} exit`).toBe(0);
    return run.stdout;
  }
  const { stdout, stderr } = await execFileAsync(res.binaryPath, [], { maxBuffer: 1 << 26 });
  expect(stderr, `${lane} stderr`).toBe("");
  return stdout;
}

function runNode(file: string): string {
  const n = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", file], { maxBuffer: 1 << 26 });
  expect(n.status).toBe(0);
  return n.stdout.toString("utf8");
}

describe("zlib on every lane: stdout equals Node's run of the same program", () => {
  test("Z-LANES-00 the oracle is Node's bundled Chromium zlib at the pinned revision", () => {
    expect(process.versions.zlib).toBe("1.3.1-e00f703");
  });

  for (const [name, file, check] of PROGRAMS) {
    test(name, async () => {
      const node = runNode(file);
      check(node);
      const outs = await Promise.all(LANES.map((lane) => runLane(file, lane)));
      for (const [i, lane] of LANES.entries()) {
        const ours = outs[i]!;
        if (ours !== node) {
          const a = ours.split("\n");
          const b = node.split("\n");
          let k = 0;
          while (k < a.length && a[k] === b[k]) k++;
          let differing = 0;
          for (let j = 0; j < Math.max(a.length, b.length); j++) if (a[j] !== b[j]) differing++;
          throw new Error(`${lane}: ${differing} of ${b.length} lines differ from Node; first at line ${k + 1}:\n  ${lane}: ${a[k]}\n  node: ${b[k]}`);
        }
      }
    }, 300000);
  }
});
