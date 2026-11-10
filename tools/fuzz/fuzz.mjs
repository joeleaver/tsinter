#!/usr/bin/env node
/* tsinter's differential fuzzer: generate programs, run them on Node and
 * on tsinter's lanes, classify, minimize the findings, dedup, report.
 * See README.md for usage. */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { ROOT } from "./exec.mjs";
import { AREAS, generate } from "./gen.mjs";
import { features, minimize } from "./minimize.mjs";
import { Pool } from "./pool.mjs";
import { writeReport } from "./report.mjs";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    count: { type: "string" },
    minutes: { type: "string" },
    jobs: { type: "string", default: String(Math.max(1, Math.min(4, cpus().length - 1))) },
    lanes: { type: "string", default: "wasm" },
    lang: { type: "string", default: "ts" },
    areas: { type: "string" },
    batch: { type: "string", default: "50" },
    out: { type: "string" },
    "no-minimize": { type: "boolean", default: false },
    "min-budget": { type: "string", default: "300" },
    "min-minutes": { type: "string", default: "15" },
    "max-minimize": { type: "string", default: "40" },
    "keep": { type: "boolean", default: false },
    "print-report": { type: "boolean", default: false },
    show: { type: "string" },
    "include-known": { type: "boolean", default: false },
    "tsc-only": { type: "boolean", default: false },
  },
});

if (args.show !== undefined) {
  process.stdout.write(generate(Number(args.show), { includeKnown: args["include-known"], ...(args.areas ? { areas: args.areas.split(",") } : {}) }).source);
  process.exit(0);
}

const seed0 = Number(args.seed);
const count = args.count !== undefined ? Number(args.count) : Infinity;
const deadline = args.minutes !== undefined ? Date.now() + Number(args.minutes) * 60_000 : Infinity;
if (count === Infinity && deadline === Infinity) {
  console.error("fuzz: give --count N or --minutes M");
  process.exit(2);
}
const lanes = args.lanes.split(",");
const jobs = Number(args.jobs);
const batch = Number(args.batch);
const genOpts = { includeKnown: args["include-known"], ...(args.areas ? { areas: args.areas.split(",").filter((a) => AREAS.includes(a)) } : {}) };
const out = args.out ?? join(tmpdir(), `tsinter-fuzz-${seed0}-${process.pid}`);
mkdirSync(out, { recursive: true });
const resultsPath = join(out, "results.jsonl");
writeFileSync(resultsPath, "");
const log = (...m) => console.error(`[fuzz ${new Date().toISOString().slice(11, 19)}]`, ...m);

function langFor(seed) {
  if (args.lang === "mix") return seed % 3 === 0 ? "js" : "ts";
  return args.lang;
}

/** The JS form of a generated program: types stripped by transpileModule,
 * and `// @ts-nocheck`, since tsinter checks JS sources (checkJs) and the
 * types that made the TS program check are gone. */
export function toJs(source) {
  return "// @ts-nocheck\n" + ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
}

function writeProgram(dir, source, lang) {
  mkdirSync(dir, { recursive: true });
  if (lang === "js") {
    writeFileSync(join(dir, "main.js"), toJs(source));
    writeFileSync(join(dir, "source.ts"), source);
    return "main.js";
  }
  writeFileSync(join(dir, "main.ts"), source);
  return "main.ts";
}

/** One tsc --noEmit over a batch, with the repo's tsconfig.base.json:
 * the set of program dirs tsc rejects. The tsconfig sits in a sibling
 * directory so tsinter's own compile never adopts it. */
function tscCheck(batchDir, dirs) {
  const cfgDir = join(batchDir, "tsc");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "tsconfig.json"), JSON.stringify({
    extends: join(ROOT, "tsconfig.base.json"),
    compilerOptions: { noEmit: true, incremental: false, declaration: false, sourceMap: false, moduleDetection: "force", types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")] },
    files: dirs.map((d) => join(d, "main.ts")),
  }));
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(cfgDir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const bad = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^(.*?\/)main\.ts\(\d+,\d+\): error (TS\d+: .*)$/.exec(line);
    if (m) {
      // tsc prints paths relative to its cwd.
      const d = resolve(m[1].replace(/\/$/, ""));
      if (!bad.has(d)) bad.set(d, m[2]);
    }
  }
  return bad;
}

function normMsg(s) {
  return String(s ?? "").replace(/\/[^\s'"\]]+/g, "<path>").replace(/\b(?!SC\d{4}\b)([A-Za-z_]*)\d+\b/g, "$1N").slice(0, 160);
}

/* `--tsc-only`: type-check `--count` programs and list the generator's
 * type errors (a generator self-test; nothing runs). */
if (args["tsc-only"]) {
  const dirs = [];
  for (let s = seed0; s < seed0 + count; s++) {
    const d = join(out, "p", String(s));
    writeProgram(d, generate(s, genOpts).source, "ts");
    dirs.push(d);
  }
  const bad = tscCheck(out, dirs);
  for (const [d, why] of bad) console.log(`${d.split("/").pop()}: ${why}`);
  console.log(`${bad.size} of ${dirs.length} programs rejected by tsc`);
  if (!args.keep) rmSync(out, { recursive: true, force: true });
  process.exit(bad.size === 0 ? 0 : 1);
}

/* ── the campaign ────────────────────────────────────────────────────── */

const pool = new Pool(jobs);
const stats = { programs: 0, invalid: 0, tscRejected: 0, prunedRuns: 0, snippetsRun: 0, perLane: {} };
for (const l of lanes) stats.perLane[l] = { match: 0, refused: 0, divergence: 0, crash: 0, invalid: 0 };
const refusalCodes = {};
const refusalMsgs = {};
const findings = []; // { seed, lane, res, source, lang }
const invalidSamples = [];
const t0 = Date.now();

let seed = seed0;
while (seed - seed0 < count && Date.now() < deadline) {
  const n = Math.min(batch, count - (seed - seed0));
  const batchDir = join(out, "p", String(seed));
  const progs = [];
  for (let i = 0; i < n; i++, seed++) {
    const g = generate(seed, genOpts);
    const dir = join(batchDir, String(seed));
    const lang = langFor(seed);
    const entry = writeProgram(dir, g.source, "ts");
    progs.push({ seed, dir, entry, lang, g });
  }
  const bad = tscCheck(batchDir, progs.map((p) => p.dir));
  await Promise.all(progs.map(async (p) => {
    stats.programs++;
    if (bad.has(p.dir)) {
      stats.tscRejected++;
      if (invalidSamples.length < 20) invalidSamples.push({ seed: p.seed, why: bad.get(p.dir) });
      appendFileSync(resultsPath, JSON.stringify({ seed: p.seed, invalid: "tsc: " + bad.get(p.dir) }) + "\n");
      return;
    }
    // A refused snippet is pruned and the rest of the program runs again
    // (the PRNG stream stays the same, so the other snippets do too).
    const skip = new Set();
    const drop = new Set();
    let res;
    let g = p.g;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        g = generate(p.seed, { ...genOpts, skip, drop });
        rmSync(p.dir, { recursive: true, force: true });
        p.entry = writeProgram(p.dir, g.source, p.lang);
        stats.prunedRuns++;
      } else if (p.lang === "js") p.entry = writeProgram(p.dir, g.source, "js");
      // Pruning runs the first lane only; the others run once, on the final program.
      res = await pool.run({ dir: p.dir, entry: p.entry, lanes: [lanes[0]] });
      if (res.timeout || res.error || res.invalid) break;
      let more = false;
      for (const l of [lanes[0]]) {
        const r = res.lanes[l];
        if (r.cls !== "refused") continue;
        for (const m of r.msgs ?? [r.msg]) {
          const k = normMsg(m);
          refusalMsgs[k] = (refusalMsgs[k] ?? 0) + 1;
        }
        for (const pl of r.places ?? []) {
          if (pl.stmt !== null && !drop.has(pl.stmt)) { drop.add(pl.stmt); more = true; }
          else if (pl.stmt === null && !skip.has(pl.snippet)) { skip.add(pl.snippet); more = true; }
        }
      }
      if (!more || attempt >= 6 || g.snippets.every((x) => skip.has(x.sid))) break;
    }
    if (lanes.length > 1 && !(res.timeout || res.error || res.invalid)) {
      const rest = await pool.run({ dir: p.dir, entry: p.entry, lanes: lanes.slice(1) });
      if (rest.timeout || rest.error || rest.invalid) {
        for (const l of lanes.slice(1)) res.lanes[l] = { cls: "crash", kind: rest.timeout ? "timeout" : rest.invalid ? "node-flake" : "worker-error", msg: (rest.error ?? rest.invalid ?? "")?.split("\n")[0] };
      } else Object.assign(res.lanes, rest.lanes);
    }
    stats.snippetsRun += g.snippets.length;
    const rec = { seed: p.seed, lang: p.lang, skipped: [...skip], dropped: drop.size };
    if (res.timeout || res.error) {
      for (const l of lanes) {
        stats.perLane[l].crash++;
        findings.push({ seed: p.seed, skip: [...skip], lane: l, lang: p.lang, source: g.source, snippets: g.snippets, res: { cls: "crash", kind: res.timeout ? "timeout" : "worker-error", msg: res.error?.split("\n")[0] } });
      }
      rec.error = res.timeout ? "timeout" : res.error;
    } else if (res.invalid) {
      stats.invalid++;
      if (invalidSamples.length < 20) invalidSamples.push({ seed: p.seed, why: res.invalid });
      rec.invalid = res.invalid;
    } else {
      rec.lanes = {};
      for (const l of lanes) {
        const r = res.lanes[l];
        stats.perLane[l][r.cls]++;
        rec.lanes[l] = { cls: r.cls, kind: r.kind, code: r.code, codes: r.codes, observer: r.diff?.observer };
        if (r.cls === "invalid" && invalidSamples.length < 20) invalidSamples.push({ seed: p.seed, why: `${l}: ${r.msg}` });
        if (r.cls === "refused") for (const c of r.code ? [r.code] : r.codes ?? []) refusalCodes[c] = (refusalCodes[c] ?? 0) + 1;
        if (r.cls === "divergence" || r.cls === "crash") findings.push({ seed: p.seed, skip: [...skip], lane: l, lang: p.lang, source: g.source, snippets: g.snippets, node: res.node, res: r });
      }
    }
    appendFileSync(resultsPath, JSON.stringify(rec) + "\n");
  }));
  if (!args.keep) rmSync(batchDir, { recursive: true, force: true });
  const L = stats.perLane[lanes[0]];
  log(`${stats.programs} programs (${((Date.now() - t0) / 1000).toFixed(0)}s): ${lanes[0]} match ${L.match} refused ${L.refused} DIVERGENCE ${L.divergence} crash ${L.crash}; invalid ${stats.invalid} tsc-rejected ${stats.tscRejected}`);
}
stats.fuzzSeconds = Math.round((Date.now() - t0) / 1000);
stats.seeds = [seed0, seed - 1];

/* ── pre-bucketing, minimization, final buckets ──────────────────────── */


function preSig(f) {
  const r = f.res;
  if (r.cls === "crash") return `crash|${r.kind}|${normMsg(r.msg ?? r.stderr0)}`;
  const area = r.diff?.snippet != null ? f.snippets?.find((s) => s.sid === r.diff.snippet)?.area ?? "?" : "?";
  return `divergence|${r.kind}|${area}|${r.diff?.observer ?? "-"}|${r.diff?.nature ?? "-"}`;
}

function samePred(f) {
  return (r) => {
    if (r === undefined || r.cls !== f.res.cls || r.kind !== f.res.kind) return false;
    if (r.cls === "crash") return normMsg(r.msg ?? r.stderr0) === normMsg(f.res.msg ?? f.res.stderr0);
    return (r.diff?.observer ?? "-") === (f.res.diff?.observer ?? "-") && r.diff?.nature === f.res.diff?.nature;
  };
}

const groups = new Map();
for (const f of findings) {
  const k = preSig(f);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
log(`${findings.length} findings in ${groups.size} pre-buckets`);

const minDir = join(out, "min");
mkdirSync(minDir, { recursive: true });
let candN = 0;
const minDeadline = Date.now() + Number(args["min-minutes"]) * 60_000;
const reps = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, Number(args["max-minimize"]));

async function evalSource(source, lang, lane) {
  const dir = join(minDir, String(++candN));
  const entry = writeProgram(dir, source, lang);
  const res = await pool.run({ dir, entry, lanes: [lane] });
  rmSync(dir, { recursive: true, force: true });
  if (res.timeout || res.error) return { r: { cls: "crash", kind: res.timeout ? "timeout" : "worker-error", msg: res.error?.split("\n")[0] }, node: null };
  if (res.invalid) return null;
  return { r: res.lanes[lane], node: res.node };
}

const minimized = await Promise.all(reps.map(async ([key, fs]) => {
  // The smallest program of the group goes first.
  const f = [...fs].sort((a, b) => a.source.length - b.source.length)[0];
  let source = f.source;
  let calls = 0;
  if (!args["no-minimize"] && f.res.kind !== "timeout") {
    const pred = samePred(f);
    const m = await minimize(f.source, async (cand) => {
      const e = await evalSource(cand, f.lang, f.lane);
      return e !== null && pred(e.r);
    }, { budget: Number(args["min-budget"]), deadline: minDeadline });
    source = m.source;
    calls = m.calls;
    // tsinter's own tsc gate is not the repo's (no exactOptionalPropertyTypes,
    // no noUncheckedIndexedAccess), so a TS repro can shrink past what the
    // repo's tsc accepts: keep the smallest step that tsc still accepts.
    if (f.lang === "ts" && m.history.length > 1) {
      const hdir = join(minDir, `h${++candN}`);
      const dirs = m.history.map((h, i) => {
        const d = join(hdir, String(i));
        writeProgram(d, h, "ts");
        return d;
      });
      const bad = tscCheck(hdir, dirs);
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (!bad.has(dirs[i])) {
          source = m.history[i];
          break;
        }
      }
      rmSync(hdir, { recursive: true, force: true });
    }
  }
  const final = f.res.kind === "timeout" ? { r: f.res, node: f.node } : (await evalSource(source, f.lang, f.lane)) ?? { r: f.res, node: f.node };
  log(`minimized ${key}: ${f.source.length} -> ${source.length} chars (${calls} tries)`);
  return { key, count: fs.length, seeds: fs.map((x) => x.seed), lanes: [...new Set(fs.map((x) => x.lane))], lang: f.lang, seed: f.seed, source, ran: f.lang === "js" ? toJs(source) : source, res: final.r ?? f.res, node: final.node ?? f.node, feats: features(source) };
}));

// Final buckets: minimized programs with the same class, kind, observer and features merge.
const buckets = new Map();
for (const m of minimized) {
  const r = m.res;
  const sig = r.cls === "crash" ? `crash|${r.kind}|${normMsg(r.msg ?? r.stderr0)}` : `divergence|${r.kind}|${r.diff?.observer ?? "-"}|${r.diff?.nature ?? "-"}|${m.feats.join(",")}`;
  const b = buckets.get(sig);
  if (b) {
    b.count += m.count;
    b.seeds.push(...m.seeds);
    b.lanes = [...new Set([...b.lanes, ...m.lanes])];
    if (m.source.length < b.source.length) Object.assign(b, { source: m.source, ran: m.ran, res: m.res, node: m.node, seed: m.seed });
  } else buckets.set(sig, { sig, ...m });
}
const unminimized = [...groups.entries()].slice(Number(args["max-minimize"])).map(([key, fs]) => ({ key, count: fs.length, seeds: fs.map((x) => x.seed).slice(0, 10) }));

pool.close();
const reportPath = writeReport(out, { args, lanes, stats, refusalCodes, refusalMsgs, invalidSamples, buckets: [...buckets.values()], unminimized });
writeFileSync(join(out, "buckets.json"), JSON.stringify([...buckets.values()], null, 1));
log(`report: ${reportPath}`);
if (args["print-report"]) process.stdout.write(readFileSync(reportPath, "utf8"));
process.exit(0);
