#!/usr/bin/env node
// Resumable driver. node run.mjs <npm|repo> [--only a,b] [--workers 4]
// One worker process per target, at most 4 at a time. A hung or crashed entry is written to the target's
// raw file as data, the process group is killed, and a fresh worker resumes after it.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DATA, HERE, RAW, appendJsonl, atomicWrite, existsSync, mkdirSync, pool, readFileSync, readJsonl, safeId } from "./lib.mjs";
import { planNpm } from "./plan.mjs";
import { planGate, planRepo } from "./plan-repo.mjs";

const stratum = process.argv[2];
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const only = arg("--only")?.split(",");
const workers = Math.min(4, Number(arg("--workers") ?? 4)); // shared box: never more than 4
const dir = join(RAW, stratum);
mkdirSync(dir, { recursive: true });

const ENTRY_TIMEOUT = { primary: 480_000, file: 240_000, batch: 480_000, tree: 480_000 };
const TARGET_BUDGET = 25 * 60_000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function targets() {
  if (stratum === "npm") {
    return readJsonl(join(DATA, "npm-packages.jsonl")).filter((r) => r.status === "ok").map((r) => ({ id: safeId(r.name), name: r.name, make: () => planNpm(r.name, safeId(r.name)) }));
  }
  const make = stratum === "repogate" ? planGate : planRepo;
  return readJsonl(join(DATA, "repo-list.jsonl")).filter((r) => r.status === "ok").map((r) => ({ id: safeId(r.repo), name: r.repo, make: () => make(r) }));
}

function spawnWorker(t) {
  return new Promise((done) => {
    // Each worker runs in its own memory cap (a transient systemd scope; the
    // box is shared): a worker the cap kills is a runaway, recorded as a
    // timeout below. SURVEY_MEMMAX=0 runs uncapped.
    const memMax = process.env.SURVEY_MEMMAX ?? "14G";
    const argv = [process.execPath, "--max-old-space-size=6144", join(HERE, "worker.mjs"), stratum, t.id];
    const capped = memMax !== "0" ? ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${memMax}`, "-p", "MemorySwapMax=0", ...argv] : argv;
    const ch = spawn(capped[0], capped.slice(1), { cwd: HERE, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let current = null, kind = "primary", stderr = "", timer, buf = "", timedOut = false;
    const kill = () => { try { process.kill(-ch.pid, "SIGKILL"); } catch {} };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; kill(); }, ENTRY_TIMEOUT[kind] ?? ENTRY_TIMEOUT.file);
    };
    arm();
    ch.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("start ")) { current = line.slice(6); kind = current === "<tree>" ? "tree" : t.kinds.get(current) ?? "file"; arm(); }
        else if (line.startsWith("done ")) { current = null; }
      }
    });
    ch.stderr.on("data", (d) => { stderr = (stderr + d).slice(-1500); });
    ch.on("close", (code, signal) => { clearTimeout(timer); kill(); done({ code, signal, current, stderr, timedOut }); });
  });
}

async function runTarget(t) {
  const out = join(dir, `${t.id}.jsonl`);
  const planFile = join(dir, `${t.id}.plan.json`);
  const doneFile = join(dir, `${t.id}.done`);
  if (existsSync(doneFile)) return;
  let plan;
  if (existsSync(planFile)) plan = JSON.parse(readFileSync(planFile, "utf8"));
  else {
    try { plan = t.make(); } catch (e) { plan = { id: t.id, name: t.name, entries: [], planError: String(e.message ?? e).slice(0, 300) }; }
    atomicWrite(planFile, JSON.stringify(plan));
  }
  t.kinds = new Map(plan.entries.map((e) => [e.name, e.kind]));
  const started = Date.now();
  for (;;) {
    const r = await spawnWorker(t);
    if (r.code === 0 && !r.timedOut) break;
    const entry = r.current ?? "<startup>";
    // A SIGKILL this driver did not send is the memory cap's: a runaway,
    // recorded as a timeout (the scope reports it as signal or as exit 137).
    const capKilled = !r.timedOut && (r.signal === "SIGKILL" || r.code === 137);
    appendJsonl(out, r.timedOut || capKilled ? { entry, kind: t.kinds.get(entry), timeout: true, ...(capKilled ? { memCap: true } : {}) } : { entry, kind: t.kinds.get(entry), processCrash: { code: r.code, signal: r.signal, stderr: r.stderr } });
    if (entry === "<startup>") break;
    if (Date.now() - started > TARGET_BUDGET) {
      const have = new Set(readJsonl(out).map((x) => x.entry));
      for (const e of plan.entries) if (!have.has(e.name)) appendJsonl(out, { entry: e.name, kind: e.kind, budget: true });
      break;
    }
  }
  atomicWrite(doneFile, String(Date.now() - started));
  log(t.name, `${plan.entries.length} entries`, `${Math.round((Date.now() - started) / 1000)}s`);
}

let list = targets();
if (only) list = list.filter((t) => only.includes(t.name));
log(stratum, list.length, "targets,", workers, "workers");
await pool(list, workers, runTarget);
log("complete");
