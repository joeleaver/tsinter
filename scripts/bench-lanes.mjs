#!/usr/bin/env node
/* The benchmark baseline (native-runner N2a): each program of
 * tests/bench/programs run on every lane, wall and CPU time and peak RSS,
 * with the ratios against Node — the reference.
 *
 *   node scripts/bench-lanes.mjs [--runs 5] [--only a,b] [--json out.json] [--out dir]
 *
 * Lanes (columns), each a runner with one interface — prepare(program)
 * answers the command line, or a reason the lane skips the program:
 *   node         Node running the program (its type-stripped JS, the same
 *                file the browser JS column loads) — the reference;
 *   wasm-v8      our WasmGC module run under Node's V8 through
 *                tests/bench/wasm-host.mjs — the STAND-IN for "our wasm in
 *                a browser" until a headless-browser runner is added;
 *   wasm-native  our wasm-native executable.
 * A browser runner is one more entry in LANES: everything it needs is
 * built per program into the output directory — `<name>.mjs` (the program
 * as plain JS: the "JS in a browser" column; it only calls console.log)
 * and `<name>.wasm` with tests/bench/wasm-host.mjs (the "our wasm in a
 * browser" column; the host uses no Node API). A program whose first lines
 * carry `// @bench-node-only` (files, sockets) is skipped by the wasm-v8
 * lane and must be skipped by browser lanes.
 *
 * Every run's stdout is checked against Node's; a lane whose output
 * differs is reported as a mismatch, not timed. Times are the median of
 * --runs runs (after one warm-up run that also checks the output); wall
 * from spawn to exit, CPU (user + system) and peak RSS from GNU time.
 * There is no pass threshold: this is the baseline the perf phase starts
 * from. Output: a table on stdout, and with --json the same numbers as
 * JSON (lanes, programs, per-lane medians and ratios to node). */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

const repo = join(import.meta.dirname, "..");
const progDir = join(repo, "tests/bench/programs");
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    only: { type: "string" },
    json: { type: "string" },
    out: { type: "string", default: join(repo, "node_modules/.cache/tsinter-bench") },
  },
});
const RUNS = Math.max(1, Number(values.runs));
const OUT = values.out;
mkdirSync(OUT, { recursive: true });

const cli = join(repo, "packages/cli/dist/main.js");

/* ── programs ─────────────────────────────────────────────────────────── */
const programs = readdirSync(progDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => {
    const src = readFileSync(join(progDir, f), "utf8");
    const head = src.split("\n", 3);
    return { name: basename(f, ".ts"), file: join(progDir, f), src, nodeOnly: head.some((l) => /^\/\/ @bench-node-only\s*$/.test(l)), what: (head[0] ?? "").replace(/^\/\/\s*/, "") };
  })
  .filter((p) => values.only === undefined || values.only.split(",").includes(p.name));

/* ── builds: the JS form, the wasm module, the wasm-native executable ── */
function build(p) {
  const js = ts.transpileModule(p.src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: p.file }).outputText;
  p.js = join(OUT, `${p.name}.mjs`);
  writeFileSync(p.js, js);
  for (const [backend, out] of [
    ["wasm", join(OUT, `${p.name}.wasm`)],
    ["wasm-native", join(OUT, `${p.name}-native`)],
  ]) {
    try {
      execFileSync(process.execPath, [cli, "build", "--backend", backend, p.file, "-o", out], { stdio: "pipe" });
      p[backend] = out;
    } catch (e) {
      p[`${backend}Refusal`] = String(e.stderr ?? e.message).split("\n")[0];
    }
  }
}

/* ── lanes ────────────────────────────────────────────────────────────── */
const LANES = [
  { name: "node", label: "Node (reference)", prepare: (p) => ({ cmd: process.execPath, args: [p.js] }) },
  {
    name: "wasm-v8",
    label: "our wasm under Node's V8 (browser stand-in)",
    prepare: (p) =>
      p.nodeOnly ? { skip: "node-only" } : p.wasm ? { cmd: process.execPath, args: [join(repo, "tests/bench/run-wasm.mjs"), p.wasm] } : { skip: `refused: ${p.wasmRefusal}` },
  },
  { name: "wasm-native", label: "our wasm-native executable", prepare: (p) => (p["wasm-native"] ? { cmd: p["wasm-native"], args: [] } : { skip: `refused: ${p["wasm-nativeRefusal"]}` }) },
];

/* one run under GNU time: wall (spawn to exit), CPU, peak RSS, stdout */
function once(cmd, args) {
  const tf = join(tmpdir(), `tsinter-bench-time-${process.pid}.txt`);
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const c = spawn("/usr/bin/time", ["-f", "%U %S %M", "-o", tf, cmd, ...args], { stdio: ["ignore", "pipe", "pipe"], cwd: OUT });
    const out = [];
    const err = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stderr.on("data", (d) => err.push(d));
    c.on("error", reject);
    c.on("close", (code) => {
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      const [u, s, m] = readFileSync(tf, "utf8").trim().split("\n").pop().split(" ").map(Number);
      rmSync(tf, { force: true });
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), wallMs: wall, cpuMs: (u + s) * 1000, rssKb: m });
    });
  });
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const results = [];
for (const p of programs) {
  build(p);
  const row = { program: p.name, what: p.what, nodeOnly: p.nodeOnly, lanes: {} };
  let expected = null;
  for (const lane of LANES) {
    const prep = lane.prepare(p);
    if (prep.skip) {
      row.lanes[lane.name] = { skip: prep.skip };
      continue;
    }
    const warm = await once(prep.cmd, prep.args);
    if (lane.name === "node") expected = warm.stdout;
    if (warm.code !== 0 || warm.stdout !== expected) {
      row.lanes[lane.name] = { mismatch: warm.code !== 0 ? `exit ${warm.code}: ${warm.stderr.trim().split("\n")[0]}` : "stdout differs from Node's" };
      continue;
    }
    const rs = [];
    for (let k = 0; k < RUNS; k++) rs.push(await once(prep.cmd, prep.args));
    row.lanes[lane.name] = { wallMs: median(rs.map((r) => r.wallMs)), cpuMs: median(rs.map((r) => r.cpuMs)), rssKb: median(rs.map((r) => r.rssKb)) };
  }
  const ref = row.lanes.node;
  for (const lane of LANES) {
    const l = row.lanes[lane.name];
    if (lane.name !== "node" && l.wallMs !== undefined && ref.wallMs !== undefined) l.ratio = { wall: l.wallMs / ref.wallMs, cpu: l.cpuMs / ref.cpuMs, rss: l.rssKb / ref.rssKb };
  }
  results.push(row);
  process.stderr.write(`bench: ${p.name} done\n`);
}

/* ── report ───────────────────────────────────────────────────────────── */
const f0 = (x) => (x === undefined ? "" : x >= 100 ? x.toFixed(0) : x.toFixed(1));
const fr = (x) => (x === undefined ? "" : `${x.toFixed(2)}x`);
const lines = [];
lines.push(`runs: median of ${RUNS}; wall/CPU in ms, RSS in MB; ratios vs Node (lower is better)`);
lines.push(["program", ...LANES.flatMap((l) => (l.name === "node" ? [`${l.name} wall`, "cpu", "rss"] : [`${l.name} wall`, "cpu", "rss", "wall×", "cpu×", "rss×"]))].join(" | "));
for (const r of results) {
  const cells = [r.program];
  for (const lane of LANES) {
    const l = r.lanes[lane.name];
    const n = lane.name === "node" ? 3 : 6;
    if (l.skip || l.mismatch) {
      cells.push(l.skip ? `skip (${l.skip})` : `MISMATCH (${l.mismatch})`, ...Array(n - 1).fill(""));
      continue;
    }
    cells.push(f0(l.wallMs), f0(l.cpuMs), f0(l.rssKb / 1024));
    if (n === 6) cells.push(fr(l.ratio?.wall), fr(l.ratio?.cpu), fr(l.ratio?.rss));
  }
  lines.push(cells.join(" | "));
}
console.log(lines.join("\n"));
if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify({ date: new Date().toISOString(), node: process.version, runs: RUNS, lanes: LANES.map((l) => ({ name: l.name, label: l.label })), artifacts: OUT, results }, null, 2) + "\n",
  );
}
