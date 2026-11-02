#!/usr/bin/env node
// Stratum B fetch. node fetch-repos.mjs [target=100] [fromStars=70]
// Candidates: GitHub's most-starred TypeScript repos (apps, mostly), topped up with the TypeScript repos
// behind the most depended-on npm packages (libraries, mostly), so the stratum is not all apps.
// Shallow clones only (no hooks, no submodules, no LFS smudge). Nothing inside a clone is ever run.
// Dependencies are tarball-extracted with no scripts, so imports resolve against real .d.ts files.
// Output: data/repo-list.jsonl. Resumable.
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { DATA, REPOS, appendJsonl, atomicWrite, existsSync, installClosure, isSource, listFiles, mkdirSync, pool, readFileSync, readJsonl, rmSync, safeId } from "./lib.mjs";

const target = Number(process.argv[2] ?? 100);
const fromStars = Number(process.argv[3] ?? 70);
const LIST = join(DATA, "repo-list.jsonl");
const DEPS = join(DATA, "repo-deps.jsonl");
const MAX_SRC_FILES = 3000; // above this a monorepo is skipped, not sampled into dominating the time budget
const MAX_SIZE_KB = 400_000;
const NOT_CODE = /(^|[-_/])(awesome|roadmap|handbook|interview|tutorial|cheatsheet|course|definitelytyped|iptv)([-_/]|$)/i;
const EXCLUDE = new Set(["vercel-labs/scriptc", "joeleaver/tsinter", "microsoft/TypeScript"]);

function libraryRepos() {
  const pk = JSON.parse(readFileSync(join(DATA, "npm-candidates.json"), "utf8")).packages;
  const seen = new Set();
  const out = [];
  for (const p of pk) {
    const m = /github\.com[/:]([^/]+\/[^/#.]+)/.exec(p.repo ?? "");
    if (!m || seen.has(m[1].toLowerCase())) continue;
    seen.add(m[1].toLowerCase());
    out.push({ repo: m[1], viaPackage: p.name, rank: p.rank });
  }
  return out;
}
function repoInfo(repo) {
  const r = JSON.parse(execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }));
  return { repo: r.full_name, stars: r.stargazers_count, sizeKB: r.size, branch: r.default_branch, language: r.language, archived: r.archived };
}

function candidates() {
  const cache = join(DATA, "repo-libs.json");
  let libs;
  if (existsSync(cache)) libs = JSON.parse(readFileSync(cache, "utf8"));
  else {
    libs = [];
    for (const l of libraryRepos().slice(0, 220)) {
      try { const i = repoInfo(l.repo); if (i.language === "TypeScript") libs.push({ ...i, viaPackage: l.viaPackage }); } catch {}
    }
    atomicWrite(cache, JSON.stringify(libs));
  }
  const stars = JSON.parse(readFileSync(join(DATA, "repo-candidates.json"), "utf8")).repos;
  return { stars: stars.map((r) => ({ ...r, origin: "stars" })), libs: libs.map((r) => ({ ...r, origin: "npm-lib" })) };
}

function clone(c, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1" };
  const url = `https://github.com/${c.repo}.git`;
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.file.allow=never", "clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", "--recurse-submodules=no", "--template=", url, dest], { env, stdio: "pipe", timeout: 900_000 });
  const git = (...a) => execFileSync("git", ["-C", dest, ...a], { encoding: "utf8", env, maxBuffer: 1 << 30 }).trim();
  const commit = git("rev-parse", "HEAD");
  const sha256 = execFileSync("bash", ["-c", 'git -C "$1" archive --format=tar HEAD | sha256sum | cut -d" " -f1', "_", dest], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();
  rmSync(join(dest, ".git"), { recursive: true, force: true });
  return { url, commit, sha256 };
}

function packageJsons(dir) {
  return listFiles(dir, { skipDirs: new Set(["node_modules", ".git", "dist", "build", "test", "tests", "fixtures", "__fixtures__", "examples", "e2e"]) })
    .filter((f) => f.endsWith("/package.json")).sort((a, b) => a.length - b.length).slice(0, 60);
}

async function one(c) {
  const id = safeId(c.repo);
  const dest = join(REPOS, id);
  const rec = { repo: c.repo, id, origin: c.origin, stars: c.stars, sizeKB: c.sizeKB, viaPackage: c.viaPackage };
  try {
    const src = { ...clone(c, dest) };
    Object.assign(rec, src);
    const all = listFiles(dest).map((f) => relative(dest, f));
    const sources = all.filter(isSource);
    rec.srcFiles = sources.length;
    rec.tsxFiles = sources.filter((f) => f.endsWith("x")).length;
    if (sources.length === 0) { rmSync(dest, { recursive: true, force: true }); return { ...rec, status: "skipped", why: "no TypeScript source outside tests/docs" }; }
    if (sources.length > MAX_SRC_FILES) { rmSync(dest, { recursive: true, force: true }); return { ...rec, status: "skipped", why: `too large (${sources.length} source files)` }; }
    const seeds = new Map();
    const workspace = new Map();
    const pjs = packageJsons(dest);
    for (const f of pjs) { try { const p = JSON.parse(readFileSync(f, "utf8")); if (p.name) workspace.set(p.name, dirname(f)); } catch {} }
    for (const f of pjs) {
      try {
        const p = JSON.parse(readFileSync(f, "utf8"));
        for (const [n, r] of Object.entries({ ...(p.peerDependencies ?? {}), ...(p.dependencies ?? {}) })) if (!workspace.has(n)) seeds.set(n, seeds.get(n) ?? r);
        for (const [n, r] of Object.entries(p.devDependencies ?? {})) if (!workspace.has(n) && /^@types\/|tsconfig/.test(n)) seeds.set(n, seeds.get(n) ?? r);
      } catch {}
    }
    seeds.delete("@types/node");
    const list = [...seeds].map(([name, range]) => ({ name, range: /^(workspace|catalog|npm|file|link|git|http)/.test(range) ? "latest" : range }));
    list.push({ name: "@types/node", range: "^24" });
    const { manifest, omitted } = await installClosure(dest, list, { cap: 700 });
    for (const m of manifest) appendJsonl(DEPS, { repo: c.repo, ...m });
    // Workspace siblings resolve to their own directories the way a pnpm/yarn link would.
    for (const [name, dir] of workspace) {
      const link = join(dest, "node_modules", name);
      if (dir === dest || existsSync(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      execFileSync("ln", ["-s", relative(dirname(link), dir), link]);
    }
    rec.deps = manifest.length;
    rec.omitted = omitted.length;
    rec.omittedSample = omitted.slice(0, 8);
    rec.workspaces = workspace.size;
    return { ...rec, status: "ok" };
  } catch (e) {
    return { ...rec, status: "failed", why: String(e.message ?? e).slice(0, 240) };
  }
}

const prior = readJsonl(LIST);
const have = new Set(prior.map((r) => r.repo));
const counts = { stars: prior.filter((r) => r.status === "ok" && r.origin === "stars").length, "npm-lib": prior.filter((r) => r.status === "ok" && r.origin === "npm-lib").length };
const quota = { stars: fromStars, "npm-lib": target - fromStars };
const { stars, libs } = candidates();
const eligible = (c) => {
  if (have.has(c.repo) || EXCLUDE.has(c.repo)) return false;
  if (NOT_CODE.test(c.repo)) { appendJsonl(LIST, { repo: c.repo, origin: c.origin, stars: c.stars, status: "skipped", why: "not a code project (by name)" }); have.add(c.repo); return false; }
  if (c.sizeKB > MAX_SIZE_KB) { appendJsonl(LIST, { repo: c.repo, origin: c.origin, stars: c.stars, sizeKB: c.sizeKB, status: "skipped", why: `too large (${Math.round(c.sizeKB / 1024)} MB repo)` }); have.add(c.repo); return false; }
  return true;
};
const queue = [...libs.filter(eligible), ...stars.filter(eligible)];
await pool(queue, 4, async (c) => {
  if (counts[c.origin] >= quota[c.origin] || have.has(c.repo)) return;
  have.add(c.repo);
  const r = await one(c);
  appendJsonl(LIST, r);
  if (r.status === "ok") counts[c.origin]++;
  console.log(new Date().toISOString().slice(11, 19), c.repo, r.status, r.why ?? "", r.srcFiles ?? "", r.deps ?? "");
});
console.log(counts);
