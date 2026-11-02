#!/usr/bin/env node
// Builds the two candidate lists. Writes data/npm-candidates.json and data/repo-candidates.json.
// Network only; nothing here touches package code.
//   node lists.mjs npm   -- ecosyste.ms: npm packages ordered by dependent_packages_count
//   node lists.mjs repos -- GitHub search (gh, read-only): language:TypeScript ordered by stars
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
mkdirSync(DATA, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const what = process.argv[2];

async function json(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "tsinter-survey" } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((f) => setTimeout(f, 2000 * (attempt + 1)));
    }
  }
}

if (what === "npm") {
  const source = "https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?sort=dependent_packages_count&order=desc";
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await json(`${source}&per_page=100&page=${page}`);
    for (const p of rows) {
      out.push({
        rank: out.length + 1, name: p.name, dependents: p.dependent_packages_count, dependentRepos: p.dependent_repos_count,
        monthlyDownloads: p.downloads, latest: p.latest_release_number, repo: p.repository_url ?? null,
      });
    }
  }
  writeFileSync(join(DATA, "npm-candidates.json"), JSON.stringify({ source, fetched: today, packages: out }, null, 0));
  console.log(out.length, "npm candidates");
} else if (what === "repos") {
  const query = "language:TypeScript stars:>3000 fork:false archived:false";
  const out = [];
  // GitHub search caps a query at 1000 results; 3 pages of 100 are far more than needed.
  for (let page = 1; page <= 4; page++) {
    const url = `search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${page}`;
    const r = JSON.parse(execFileSync("gh", ["api", url], { encoding: "utf8", maxBuffer: 1 << 28 }));
    for (const x of r.items) {
      out.push({
        rank: out.length + 1, repo: x.full_name, stars: x.stargazers_count, sizeKB: x.size, branch: x.default_branch,
        language: x.language, topics: x.topics ?? [], description: (x.description ?? "").slice(0, 120),
      });
    }
  }
  writeFileSync(join(DATA, "repo-candidates.json"), JSON.stringify({ source: `GitHub search: ${query} (sort=stars)`, fetched: today, repos: out }, null, 0));
  console.log(out.length, "repo candidates");
} else {
  console.error("usage: lists.mjs npm|repos");
  process.exit(2);
}
