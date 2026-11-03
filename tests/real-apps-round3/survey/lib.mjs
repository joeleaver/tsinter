// Shared plumbing: cache layout, registry access, integrity-checked tarball store, closure resolver.
// No package code runs here. Tarballs are fetched directly (no npm install, no lifecycle scripts) and
// unpacked with tar; symlinks inside them are deleted so a package cannot reach outside its directory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = join(HERE, "data");
export const ROOT = process.env.SURVEY_CACHE ?? join(homedir(), ".cache/tsinter-dl/survey");
export const TARBALLS = join(ROOT, "tarballs");
export const PACKUMENTS = join(ROOT, "packuments");
export const TREES = join(ROOT, "npm");
export const REPOS = join(ROOT, "repos");
export const RAW = process.env.SURVEY_RAW ?? join(ROOT, "raw"); // SURVEY_RAW: a re-run beside the committed one
for (const d of [DATA, ROOT, TARBALLS, PACKUMENTS, TREES, REPOS, RAW]) mkdirSync(d, { recursive: true });

// npm's own bundled semver (ships with node, not a surveyed package).
const npmRoot = join(dirname(dirname(process.execPath)), "lib/node_modules/npm/node_modules/");
export const semver = createRequire(npmRoot + "x.js")("semver");

export const safeId = (s) => s.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "__");
export const sleep = (ms) => new Promise((f) => setTimeout(f, ms));

/** Bounded worker pool: `limit` concurrent `fn(item)`. */
export async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export async function get(url, { accept, binary } = {}) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { "user-agent": "tsinter-survey", ...(accept ? { accept } : {}) } });
      if (r.status === 404) { const e = new Error(`404 ${url}`); e.notFound = true; throw e; }
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) {
      last = e;
      if (e.notFound) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

const memo = new Map();
export async function packument(name) {
  if (memo.has(name)) return memo.get(name);
  const file = join(PACKUMENTS, safeId(name) + ".json");
  const p = (async () => {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
    const text = await get(url, { accept: "application/vnd.npm.install-v1+json" });
    const d = JSON.parse(text);
    // Keep only what resolution needs; full packuments of old packages are huge.
    const slim = { name: d.name, tags: d["dist-tags"], versions: {} };
    for (const [v, m] of Object.entries(d.versions)) {
      slim.versions[v] = {
        dependencies: m.dependencies, peerDependencies: m.peerDependencies, peerDependenciesMeta: m.peerDependenciesMeta,
        dist: { tarball: m.dist.tarball, integrity: m.dist.integrity, shasum: m.dist.shasum, unpackedSize: m.dist.unpackedSize },
      };
    }
    atomicWrite(file, JSON.stringify(slim));
    return slim;
  })();
  memo.set(name, p);
  return p;
}

export function atomicWrite(file, text) {
  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function pickVersion(pk, range) {
  const latest = pk.tags?.latest;
  if (!range || range === "*" || range === "latest") return latest;
  if (latest && pk.versions[latest] && semver.validRange(range) && semver.satisfies(latest, range)) return latest;
  if (pk.tags?.[range]) return pk.tags[range];
  if (!semver.validRange(range)) return null; // git:, file:, workspace:, http: ranges
  return semver.maxSatisfying(Object.keys(pk.versions), range);
}

function verify(buf, dist) {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (dist.integrity) {
    for (const entry of dist.integrity.split(/\s+/)) {
      const [alg, want] = entry.split("-");
      if (createHash(alg).update(buf).digest("base64") === want) return sha256;
    }
    throw new Error(`integrity mismatch (${dist.integrity})`);
  }
  if (dist.shasum) {
    if (createHash("sha1").update(buf).digest("hex") !== dist.shasum) throw new Error("shasum mismatch");
    return sha256;
  }
  throw new Error("registry published no integrity data");
}

/** Download, verify, and unpack one version into tarballs/<id>/{package.tgz,package/,SOURCE.json}. */
export async function storeTarball(name, version, meta) {
  const dir = join(TARBALLS, `${safeId(name)}__${version}`);
  const src = join(dir, "SOURCE.json");
  if (existsSync(src)) return { dir, ...JSON.parse(readFileSync(src, "utf8")) };
  mkdirSync(dir, { recursive: true });
  const url = meta.dist.tarball;
  const buf = await get(url, { binary: true });
  const sha256 = verify(buf, meta.dist);
  writeFileSync(join(dir, "package.tgz"), buf);
  const out = join(dir, "package");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  // No execution: tar only. --no-same-owner/-permissions so modes do not carry over.
  execFileSync("tar", ["xzf", join(dir, "package.tgz"), "-C", out, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { stdio: "pipe" });
  execFileSync("find", [out, "-type", "l", "-delete"]);
  execFileSync("chmod", ["-R", "u+rwX,go-w,a-x+X", out]);
  const rec = { name, version, url, integrity: meta.dist.integrity ?? null, shasum: meta.dist.shasum ?? null, sha256, bytes: buf.length };
  atomicWrite(src, JSON.stringify(rec));
  return { dir, ...rec };
}

export const CLOSURE_CAP = 250;
const TEST_PATH = /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|e2e|spec|specs|fixtures?|examples?|demos?|docs?|website|sandbox|playground|benchmarks?|bench|vendor|third[-_]party|dist|build|out|lib-esm|coverage|generated|node_modules|\.[^/]+)(\/|$)/i;
const TEST_FILE = /\.(test|spec|bench|stories|e2e|cy|d)\.[cm]?tsx?$|\.d\.[cm]?ts$/i;
/** Hand-written TypeScript source, by repo-relative path. */
export const isSource = (rel) => /\.[cm]?tsx?$/.test(rel) && !TEST_PATH.test(rel) && !TEST_FILE.test(rel);
const OMIT_BYTES = 80 * 1024 * 1024;

/** Resolves a runtime dependency closure (dependencies + required peers; optionalDependencies skipped)
 * and lays it out Node-style under <tree>/node_modules: hoist to the top, nest on a version conflict. */
export async function installClosure(tree, seeds, { reserve = new Map(), cap = CLOSURE_CAP } = {}) {
  const nm = join(tree, "node_modules");
  mkdirSync(nm, { recursive: true });
  const placed = new Map(reserve); // "dir|name" handled by parentChain below
  const top = new Map(reserve); // name -> version at the top level
  const omitted = [];
  const manifest = [];
  const queue = seeds.map((s) => ({ name: s.name, range: s.range, parent: null }));
  const done = new Set();
  let count = 0;
  while (queue.length > 0) {
    const batch = queue.splice(0, 8);
    await Promise.all(batch.map(async ({ name, range, parent }) => {
      try {
        const key = `${parent ?? ""}|${name}|${range}`;
        if (done.has(key)) return;
        done.add(key);
        const pk = await packument(name);
        const version = pickVersion(pk, range);
        if (!version || !pk.versions[version]) { omitted.push({ name, range, why: "no matching version" }); return; }
        const meta = pk.versions[version];
        let dest;
        if (!top.has(name)) { top.set(name, version); dest = join(nm, name); }
        else if (top.get(name) === version) return;
        else if (parent === null) return;
        else dest = join(parent, "node_modules", name);
        if (existsSync(dest) || placed.has(dest)) return;
        placed.set(dest, version);
        if (++count > cap) { omitted.push({ name, range, why: `closure cap ${cap}` }); return; }
        if ((meta.dist.unpackedSize ?? 0) > OMIT_BYTES) { omitted.push({ name, version, why: "dependency over 80 MB" }); return; }
        const t = await storeTarball(name, version, meta);
        mkdirSync(dirname(dest), { recursive: true });
        // Hardlinks into the verified store: cheap, and the trees are never written to.
        execFileSync("cp", ["-al", join(t.dir, "package"), dest]);
        manifest.push({ name, version, url: t.url, sha256: t.sha256 });
        for (const [dn, dr] of Object.entries(meta.dependencies ?? {})) queue.push({ name: dn, range: dr, parent: dest });
        for (const [dn, dr] of Object.entries(meta.peerDependencies ?? {})) {
          if (meta.peerDependenciesMeta?.[dn]?.optional) continue;
          queue.push({ name: dn, range: dr, parent: dest });
        }
      } catch (e) {
        omitted.push({ name, range, why: String(e.message ?? e).slice(0, 140) });
      }
    }));
  }
  return { manifest, omitted };
}

export function listFiles(root, { skipDirs = new Set(["node_modules", ".git"]) } = {}) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(p); }
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

export const appendJsonl = (file, rec) => appendFileSync(file, JSON.stringify(rec) + "\n");
export const readJsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
export { statSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync };
