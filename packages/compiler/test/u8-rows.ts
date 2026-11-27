/* Shared harness for the U8 speed rows (wasm-u8*.test.ts,
 * docs/design/u8-dynamic-speed.md §9). Each row is a program whose source
 * holds `__R__`, the number of rounds of its hot loop:
 *
 *   - the production build (no instrumentation) at 2 rounds is compared
 *     with Node byte for byte (stdout, stderr, exit code) on the wasm and
 *     wasm-native lanes;
 *   - when the row names `perRound`, builds with SCRIPTC_WASM_IC_STATS=1 at
 *     1 and at 2 rounds print the program's `$dyn` box count (ic-stats.ts),
 *     their stdout still matches Node's, and the difference between the two
 *     counts is the boxes one round allocates: a number asserts exactly
 *     that many (0 is the fast path), "some" asserts at least one (a row
 *     that proves a fallback ran the generic, boxing path).
 *
 * The counts are deterministic, so the speed checks never time anything
 * and cannot flake. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);

export interface U8Row {
  id: string;
  /** A TypeScript program; `__R__` is replaced by the round count. */
  src: string;
  /** The `$dyn` boxes one round allocates (SCRIPTC_WASM_IC_STATS=1). */
  perRound?: number | "some";
}

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Lane = "wasm" | "wasm-native";

const STATS_LINE = /^tsinter-stats: dyn-allocs (\d+)\n$/m;

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function laneRun(lane: Lane, path: string): Promise<Out> {
  if (lane === "wasm") {
    const r = await runWasm(path);
    return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
  }
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

/** Builds `src` at `rounds` rounds on `lane` (instrumented when `stats`),
 * runs it, and runs the same program under Node. */
async function build(dir: string, row: U8Row, lane: Lane, rounds: number, stats: boolean): Promise<{ got: Out; node: Out }> {
  const sub = join(dir, `r${rounds}${stats ? "s" : ""}`);
  mkdirSync(sub, { recursive: true });
  const entry = join(sub, "main.ts");
  writeFileSync(entry, row.src.replaceAll("__R__", String(rounds)) + "\n");
  const prev = process.env["SCRIPTC_WASM_IC_STATS"];
  if (stats) process.env["SCRIPTC_WASM_IC_STATS"] = "1";
  else delete process.env["SCRIPTC_WASM_IC_STATS"];
  let res: Awaited<ReturnType<typeof compile>>;
  try {
    res = await compile(entry, { outPath: join(sub, lane === "wasm" ? "p.wasm" : "program"), outDir: sub, backend: lane });
  } finally {
    if (prev === undefined) delete process.env["SCRIPTC_WASM_IC_STATS"];
    else process.env["SCRIPTC_WASM_IC_STATS"] = prev;
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${lane}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  return { got: await laneRun(lane, res.binaryPath!), node: nodeRun(entry) };
}

/** The box count an instrumented run printed, and its stderr without the
 * report line. */
function statsOf(o: Out): { allocs: number; stderr: string } {
  const m = STATS_LINE.exec(o.stderr);
  if (m === null) throw new Error(`no stats line in stderr: ${JSON.stringify(o.stderr)}`);
  return { allocs: Number(m[1]), stderr: o.stderr.replace(STATS_LINE, "") };
}

export function defineU8Rows(title: string, rows: U8Row[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "tsinter-u8-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const check = async (row: U8Row, lane: Lane): Promise<void> => {
    const dir = join(scratch, `${row.id.split(" ")[0]}-${lane}`);
    const prod = await build(dir, row, lane, 2, false);
    expect(prod.got).toEqual(prod.node);
    if (row.perRound === undefined) return;
    const counts: number[] = [];
    for (const rounds of [1, 2]) {
      const { got, node } = await build(dir, row, lane, rounds, true);
      const s = statsOf(got);
      expect({ ...got, stderr: s.stderr }).toEqual(node);
      counts.push(s.allocs);
    }
    const delta = counts[1]! - counts[0]!;
    if (row.perRound === "some") expect(delta).toBeGreaterThan(0);
    else expect(delta).toBe(row.perRound);
  };
  for (const lane of ["wasm", "wasm-native"] as const) {
    describe(`${title} (${lane} lane vs Node)`, () => {
      test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
        await check(row, lane);
      }, 600_000);
    });
  }
}
