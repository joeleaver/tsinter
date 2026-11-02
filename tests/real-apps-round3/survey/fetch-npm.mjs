#!/usr/bin/env node
// Stratum A fetch. node fetch-npm.mjs [target=300]
// Walks data/npm-candidates.json in rank order and keeps packages until `target` ship runtime JS.
// Type-only packages are recorded and skipped. Resumable: a root with a tree/.done marker is not redone.
// Output: data/npm-packages.jsonl (one record per root) and data/npm-deps.jsonl (every dependency tarball).
import { join } from "node:path";
import { DATA, TREES, appendJsonl, atomicWrite, existsSync, installClosure, listFiles, mkdirSync, packument, pickVersion, pool, readFileSync, readJsonl, rmSync, safeId, storeTarball, writeFileSync } from "./lib.mjs";

const target = Number(process.argv[2] ?? 300);
const candidates = JSON.parse(readFileSync(join(DATA, "npm-candidates.json"), "utf8")).packages;
const LIST = join(DATA, "npm-packages.jsonl");
const DEPS = join(DATA, "npm-deps.jsonl");
const have = new Map(readJsonl(LIST).map((r) => [r.name, r]));
const seenDeps = new Set(readJsonl(DEPS).map((d) => `${d.name}@${d.version}`));
let usable = [...have.values()].filter((r) => r.status === "ok").length;

const JS = /\.(js|cjs|mjs)$/;
async function one(c) {
  if (usable >= target || have.has(c.name)) return;
  const rec = { rank: c.rank, name: c.name, dependents: c.dependents, monthlyDownloads: c.monthlyDownloads };
  if (c.name.startsWith("@types/")) {
    appendJsonl(LIST, { ...rec, status: "skipped", why: "@types package" });
    return;
  }
  try {
    const pk = await packument(c.name);
    const version = pickVersion(pk, "latest");
    const meta = pk.versions[version];
    const t = await storeTarball(c.name, version, meta);
    Object.assign(rec, { version, url: t.url, integrity: t.integrity, sha256: t.sha256, bytes: t.bytes });
    const files = listFiles(join(t.dir, "package"));
    const jsFiles = files.filter((f) => JS.test(f));
    if (jsFiles.length === 0) {
      appendJsonl(LIST, { ...rec, status: "skipped", why: "no runtime JS in tarball" });
      return;
    }
    const tree = join(TREES, safeId(c.name));
    if (!existsSync(join(tree, ".done"))) {
      rmSync(tree, { recursive: true, force: true });
      mkdirSync(tree, { recursive: true });
      const { manifest, omitted } = await installClosure(tree, [{ name: c.name, range: version }]);
      for (const m of manifest) {
        const k = `${m.name}@${m.version}`;
        if (!seenDeps.has(k)) { seenDeps.add(k); appendJsonl(DEPS, m); }
      }
      rec.closure = manifest.length - 1;
      rec.omitted = omitted;
      writeFileSync(join(tree, "closure.json"), JSON.stringify(manifest.map((m) => m.name)));
      atomicWrite(join(tree, ".done"), "");
    }
    usable++;
    appendJsonl(LIST, { ...rec, status: "ok", jsFiles: jsFiles.length });
    if (usable % 25 === 0) console.log(new Date().toISOString(), usable, "usable, at rank", c.rank);
  } catch (e) {
    appendJsonl(LIST, { ...rec, status: "failed", why: String(e.message ?? e).slice(0, 200) });
  }
}

await pool(candidates, 4, one);
console.log("usable", usable);
