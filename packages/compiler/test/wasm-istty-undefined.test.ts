/* GH #88 (SEMANTICS.md S121): Node's process.stdin/stdout/stderr on a pipe
 * or file has no `isTTY` property, so the read is `undefined`. Unit U
 * (S119) lets a bool slot hold `undefined` on the WasmGC lanes, so the
 * wasm and wasm-native lanes answer exactly that; a terminal still reads
 * `true`. The c and llvm lanes keep `false` (S121), which is why this is a
 * compiler test and not a corpus program. Every row runs under Node (the
 * oracle, spawned at test time with stdin, stdout and stderr all pipes)
 * and on both WasmGC lanes. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh88-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
}

async function nodeRun(file: string): Promise<Out> {
  const p = run(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8" });
  p.child.stdin?.end();
  const r = await p;
  return { stdout: r.stdout, stderr: r.stderr };
}

async function wasmRun(id: string, file: string): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  expect(r.exitCode).toBe(0);
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const p = run(res.binaryPath, [], { encoding: "utf8" });
  p.child.stdin?.end();
  const r = await p;
  return { stdout: r.stdout, stderr: r.stderr };
}

const ROWS: { id: string; ext: "ts" | "mjs"; src: string }[] = [
  {
    // the real-app trial's repro (tests/real-apps-round2/silent/03)
    id: "01-round2-repro",
    ext: "ts",
    src: `console.log(process.stdout.isTTY, typeof process.stdout.isTTY, String(process.stderr.isTTY));`,
  },
  {
    id: "02-observers",
    ext: "ts",
    src: `const t = process.stdout.isTTY;
console.log(t === undefined, t === false, t === true, t == null, t ?? false, \`<\${t}>\`, "" + t);
console.log(!t, t ? "tty" : "pipe", Boolean(t), JSON.stringify({ t }), JSON.stringify([t]));
console.log(typeof process.stdin.isTTY, process.stdin.isTTY, typeof process.stderr.isTTY);
if (process.stderr.isTTY) console.log("stderr tty"); else console.log("stderr not a tty");
const flags = [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY];
console.log(flags.map((f) => String(f)).join(","), flags.filter((f) => f === undefined).length);
console.error("err", process.stderr.isTTY);`,
  },
  {
    // the commander help-width probe shape, in JavaScript
    id: "03-js-probe",
    ext: "mjs",
    src: `const width = process.stdout.isTTY ? process.stdout.columns : undefined;
console.log(width, process.stdout.isTTY, typeof process.stderr.isTTY);
const color = process.stdout.isTTY === true;
console.log(color, process.stdout.isTTY !== false);`,
  },
];

describe("GH #88: isTTY on a non-TTY stream is undefined (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    const [node, wasm] = await Promise.all([nodeRun(file), wasmRun(id, file)]);
    expect(wasm).toEqual(node);
  });
});

describe("GH #88: the same rows on the wasm-native lane", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    const [node, wn] = await Promise.all([nodeRun(file), nativeRun(id, file)]);
    expect(wn).toEqual(node);
  }, 600_000);
});
