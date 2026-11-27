/* Shared harness for the U8 speed rows (wasm-u8*.test.ts,
 * docs/design/u8-dynamic-speed.md §9). Each row is a program whose source
 * holds `__R__`, the number of rounds of its hot loop:
 *
 *   - the production build (no instrumentation) at 2 rounds is compared
 *     with Node byte for byte (stdout, stderr, exit code) on the wasm and
 *     wasm-native lanes;
 *   - with `{ shapeCheck: true }` (defineU8Rows), the same build made
 *     with SCRIPTC_WASM_SHAPE_CHECK=1 also matches Node: every shape-cache
 *     hit re-verifies its answer against the uncached read and traps on a
 *     difference (ic-read.ts), so a stale hit cannot pass as a match;
 *   - when the row names `perRound` or `stats`, builds with
 *     SCRIPTC_WASM_IC_STATS=1 at 1 and at 2 rounds print the program's
 *     counters (ic-stats.ts: `$dyn` boxes, cache hits and misses, shapes
 *     made), their stdout still matches Node's, and the difference between
 *     the two runs' counts is what one round does. `perRound` is the boxes
 *     one round allocates: a number asserts exactly that many (0 is the
 *     fast path), "some" asserts at least one (a row that proves a
 *     fallback ran the generic, boxing path). `stats` names per-round
 *     expectations for any counter the same way, and `totals` exact
 *     counts of the 1-round build (shapes made by a parse, say).
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
  /** A TypeScript program (JavaScript when `js`); `__R__` is replaced by
   * the round count. */
  src: string;
  /** The program is JavaScript (main.js): untyped literals and containers
   * that a TypeScript program cannot hand to dynamic code. */
  js?: boolean;
  /** The `$dyn` boxes one round allocates (SCRIPTC_WASM_IC_STATS=1). */
  perRound?: Expect;
  /** Per-round expectations for the other counters. */
  stats?: Partial<Record<Counter, Expect>>;
  /** Exact counts of the 1-round build. */
  totals?: Partial<Record<Counter, number>>;
}

/** The counters an instrumented build reports (ic-stats.ts). */
export type Counter = "dyn-allocs" | "ic-hits" | "ic-misses" | "shapes" | "ic-megas" | "set-hits" | "set-misses" | "lit-hits";

/** Exactly this many, or at least one ("some"), or at most `max`. */
export type Expect = number | "some" | { max: number };

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Lane = "wasm" | "wasm-native";

const STATS_LINE = /^tsinter-stats: ([a-z-]+) (\d+)\n/gm;

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

/** The build flavours: production, instrumented (SCRIPTC_WASM_IC_STATS)
 * and shape-checked (SCRIPTC_WASM_SHAPE_CHECK). */
type Flavour = "prod" | "stats" | "check";

const FLAVOUR_ENV: Record<Exclude<Flavour, "prod">, string> = {
  stats: "SCRIPTC_WASM_IC_STATS",
  check: "SCRIPTC_WASM_SHAPE_CHECK",
};

/** Builds `src` at `rounds` rounds on `lane` as `flavour`, runs it, and
 * runs the same program under Node. */
async function build(dir: string, row: U8Row, lane: Lane, rounds: number, flavour: Flavour): Promise<{ got: Out; node: Out }> {
  const sub = join(dir, `r${rounds}${flavour}`);
  mkdirSync(sub, { recursive: true });
  const entry = join(sub, row.js === true ? "main.js" : "main.ts");
  writeFileSync(entry, row.src.replaceAll("__R__", String(rounds)) + "\n");
  const prev = Object.fromEntries(Object.values(FLAVOUR_ENV).map((k) => [k, process.env[k]]));
  for (const [f, k] of Object.entries(FLAVOUR_ENV)) {
    if (f === flavour) process.env[k] = "1";
    else delete process.env[k];
  }
  let res: Awaited<ReturnType<typeof compile>>;
  try {
    res = await compile(entry, { outPath: join(sub, lane === "wasm" ? "p.wasm" : "program"), outDir: sub, backend: lane });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  if (!res.ok) throw new Error(`${row.id} refused on ${lane}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  return { got: await laneRun(lane, res.binaryPath!), node: nodeRun(entry) };
}

/** The counts an instrumented run printed, and its stderr without the
 * report lines. */
function statsOf(o: Out): { counts: Record<string, number>; stderr: string } {
  const counts: Record<string, number> = {};
  for (const m of o.stderr.matchAll(STATS_LINE)) counts[m[1]!] = Number(m[2]);
  if (counts["dyn-allocs"] === undefined) throw new Error(`no stats lines in stderr: ${JSON.stringify(o.stderr)}`);
  return { counts, stderr: o.stderr.replace(STATS_LINE, "") };
}

function expectCount(what: string, got: number, want: Expect): void {
  if (want === "some") expect(got, what).toBeGreaterThan(0);
  else if (typeof want === "number") expect(got, what).toBe(want);
  else expect(got, what).toBeLessThanOrEqual(want.max);
}

export function defineU8Rows(title: string, rows: U8Row[], opts: { shapeCheck?: boolean } = {}): void {
  const scratch = mkdtempSync(join(tmpdir(), "tsinter-u8-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const check = async (row: U8Row, lane: Lane): Promise<void> => {
    const dir = join(scratch, `${row.id.split(" ")[0]}-${lane}`);
    const prod = await build(dir, row, lane, 2, "prod");
    expect(prod.got).toEqual(prod.node);
    if (opts.shapeCheck === true) {
      const checked = await build(dir, row, lane, 2, "check");
      expect(checked.got, "shape-checked build").toEqual(checked.node);
    }
    if (row.perRound === undefined && row.stats === undefined && row.totals === undefined) return;
    const runs: Record<string, number>[] = [];
    for (const rounds of [1, 2]) {
      const { got, node } = await build(dir, row, lane, rounds, "stats");
      const s = statsOf(got);
      expect({ ...got, stderr: s.stderr }).toEqual(node);
      runs.push(s.counts);
    }
    const delta = (c: Counter): number => runs[1]![c]! - runs[0]![c]!;
    if (row.perRound !== undefined) expectCount("dyn-allocs per round", delta("dyn-allocs"), row.perRound);
    for (const [c, want] of Object.entries(row.stats ?? {}) as [Counter, Expect][]) expectCount(`${c} per round`, delta(c), want);
    for (const [c, want] of Object.entries(row.totals ?? {}) as [Counter, number][]) expect(runs[0]![c], `${c} at 1 round`).toBe(want);
  };
  for (const lane of ["wasm", "wasm-native"] as const) {
    describe(`${title} (${lane} lane vs Node)`, () => {
      test.for(rows.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
        await check(row, lane);
      }, 600_000);
    });
  }
}
