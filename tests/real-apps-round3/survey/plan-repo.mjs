// Stratum B plan: each selected source file is analyzed directly as an entry, under the repo's own tsconfig.
// A file's analysis also covers what it imports. Above MAX_ENTRIES an evenly spaced sample is taken so a big
// repo costs about as much as a small one; family presence in a sampled repo is a lower bound.
import { join, relative } from "node:path";
import { RAW, REPOS, isSource, listFiles, readFileSync, readJsonl } from "./lib.mjs";

const MAX_ENTRIES = 120;

export function planRepo(r) {
  const root = join(REPOS, r.id);
  const files = listFiles(root).map((f) => relative(root, f)).filter(isSource).sort();
  let picked = files;
  if (files.length > MAX_ENTRIES) {
    picked = [];
    for (let i = 0; i < MAX_ENTRIES; i++) picked.push(files[Math.floor((i * files.length) / MAX_ENTRIES)]);
  }
  const entries = picked.map((f, i) => ({ name: f, kind: i === 0 ? "primary" : "file", wrapper: join(root, f), compile: i === 0 }));
  return { id: r.id, name: r.repo, entries, tree: null, srcFiles: files.length, sampled: picked.length };
}

/** Second pass: only the entries the first pass stopped at the type-check gate. */
export function planGate(r) {
  const first = JSON.parse(readFileSync(join(RAW, "repo", `${r.id}.plan.json`), "utf8"));
  const stopped = new Set(readJsonl(join(RAW, "repo", `${r.id}.jsonl`)).filter((x) => x.preflightFailed).map((x) => x.entry));
  const entries = first.entries.filter((e) => stopped.has(e.name)).map((e, i) => ({ ...e, kind: i === 0 ? "primary" : "file", compile: false }));
  return { id: r.id, name: r.repo, entries, tree: null };
}
