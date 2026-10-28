#!/usr/bin/env node
/* Vendors the OpenSSL Node bundles — Node v24.18.1's deps/openssl, OpenSSL
 * 3.5.7 (`process.versions.openssl`) — into packages/runtime/vendor/openssl/,
 * pruned to what the no-asm build of libssl + libcrypto reads, and generates
 * packages/compiler/src/backend/openssl-sources.ts (the per-target source
 * lists, defines and include dirs, read from Node's own
 * config/archs/<target>/no-asm/openssl.gypi). The native runner's host links
 * the result (backend/openssl-build.ts; design: the OpenSSL units O1-O5).
 *
 *   node scripts/vendor-openssl.mjs                # fetch the tag, rewrite the tree
 *   node scripts/vendor-openssl.mjs --check        # fetch the tag, require byte-identity
 *   node scripts/vendor-openssl.mjs --from <dir>   # use a Node checkout at the tag
 *                                                  # instead of fetching (offline)
 *
 * Node builds OpenSSL with gyp and never runs perl or Configure: the
 * per-target generated headers and C files sit pre-generated under
 * deps/openssl/config/archs/<target>/{no-asm,asm,asm_avx2}/. We take the
 * no-asm set — value-identical to Node's asm build (the same algorithms,
 * groups and cipher lists; only the bulk primitives' speed differs) and
 * compilable with clang for every target with no assembler.
 *
 * What is vendored, every file byte-identical to the tag (no file is
 * modified):
 * - openssl/: the .c files the targets' no-asm openssl.gypi lists (union),
 *   the .c files those #include (o_dir.c's LPdir_*.c, ncbc_enc.c, ...), and
 *   every .h/.inc under openssl/{include,crypto,ssl,providers,engines};
 *   openssl/LICENSE.txt (Apache-2.0) and VERSION.dat.
 * - config/archs/<target>/no-asm/: the generated headers (include/,
 *   crypto/buildinf.h, providers/common/include/), the generated C
 *   (crypto/params_idx.c, providers/common/der/*_gen.c) and openssl.gypi,
 *   for TARGETS below.
 * - openssl.gyp, openssl_common.gypi, openssl_no_asm.gypi: where the
 *   recipe's Node-level defines and include dirs come from (provenance).
 * - LICENSE.node: Node's LICENSE (its OpenSSL section and Node's own terms).
 * NOT vendored: config/*.h — Node's dispatch headers, which pick an arch
 * directory by predefined macros (_M_X64 and friends, which a mingw or
 * cross clang does not define). The recipe puts the target's arch include
 * directory FIRST instead, so the forwarding headers under
 * openssl/include/ (`#include "../../../config/ssl.h"`) are never reached;
 * if one were, the build would fail loudly on the missing file rather than
 * pick another target's configuration.
 *
 * The tree is fetched with a blobless, sparse, depth-1 clone of
 * https://github.com/nodejs/node at the tag; the tag must resolve to
 * NODE_COMMIT. --check rebuilds the whole output (tree + openssl-sources.ts)
 * into a temporary directory and requires the checked-in copies to be
 * byte-identical, file set included. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorOut = join(root, "packages/runtime/vendor/openssl");
const sourcesOut = join(root, "packages/compiler/src/backend/openssl-sources.ts");

const NODE_TAG = "v24.18.1";
const NODE_COMMIT = "9623d9ad85d37d2f0610ec4a82b48182cf2c6061";
const NODE_REPO = "https://github.com/nodejs/node";
/** Node's no-asm configurations for the tsinter targets (design §4):
 * linux x64/arm64 (and Android, which Node maps to the same two), macOS
 * x64/arm64, Windows x64 (VC-WIN64A; Windows arm64 is not a tsinter
 * target yet). */
const TARGETS = ["linux-x86_64", "linux-aarch64", "darwin64-x86_64-cc", "darwin64-arm64-cc", "VC-WIN64A"];
const SOURCE_TREES = ["include", "crypto", "ssl", "providers", "engines"];
const GYP_FILES = ["openssl.gyp", "openssl_common.gypi", "openssl_no_asm.gypi"];

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const rel = (base, p) => p.slice(base.length + 1).split("\\").join("/");

/** A blobless sparse clone of the tag, only the paths we read checked out. */
function fetchNode(dest) {
  const git = (...a) => execFileSync("git", a, { cwd: dest, stdio: ["ignore", "pipe", "inherit"] }).toString();
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", NODE_TAG, NODE_REPO, dest], { stdio: "inherit" });
  const head = git("rev-parse", "HEAD").trim();
  if (head !== NODE_COMMIT) throw new Error(`${NODE_TAG} resolved to ${head}, expected ${NODE_COMMIT}`);
  const patterns = [
    "/LICENSE",
    ...GYP_FILES.map((f) => `/deps/openssl/${f}`),
    "/deps/openssl/openssl/LICENSE.txt",
    "/deps/openssl/openssl/VERSION.dat",
    ...SOURCE_TREES.map((t) => `/deps/openssl/openssl/${t}/`),
    ...TARGETS.map((t) => `/deps/openssl/config/archs/${t}/no-asm/`),
  ];
  git("sparse-checkout", "set", "--no-cone", ...patterns);
  git("checkout", "--quiet", NODE_COMMIT);
  return join(dest, "deps/openssl");
}

/** The named lists of a generated openssl.gypi ('name': ['a', 'b', ...]);
 * the first of a name wins (the target's own include_dirs come before
 * direct_dependent_settings'). */
function gypiLists(text) {
  const lists = {};
  for (const m of text.matchAll(/'([\w.-]+)'\s*:\s*\[([^\]]*)\]/g)) lists[m[1]] ??= [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return lists;
}

/** Derives the vendored file set and the generated module from a deps/openssl tree. */
function derive(src) {
  const files = new Set(["openssl/LICENSE.txt", "openssl/VERSION.dat", ...GYP_FILES]);
  const perTarget = {};
  const common = gypiLists(readFileSync(join(src, "openssl_common.gypi"), "utf8"))["include_dirs"];
  if (common === undefined) throw new Error("openssl_common.gypi: no include_dirs");
  for (const t of TARGETS) {
    const archRel = `config/archs/${t}/no-asm`;
    const gypi = readFileSync(join(src, archRel, "openssl.gypi"), "utf8");
    const lists = gypiLists(gypi);
    const sources = lists["openssl_sources"];
    const archSources = (lists[`openssl_sources_${t}`] ?? []).filter((s) => s.endsWith(".c"));
    const defines = lists[`openssl_defines_${t}`];
    const includeDirs = lists["include_dirs"];
    if (sources === undefined || defines === undefined || includeDirs === undefined) throw new Error(`${archRel}/openssl.gypi: unexpected shape`);
    // arch-relative paths: the gypi is included from deps/openssl, its
    // './config/archs/...' sources are relative to deps/openssl and its
    // include_dirs to the gypi's own directory (gyp's rule).
    const arch = archSources.map((s) => posix.normalize(s));
    const inc = includeDirs.map((d) => posix.normalize(posix.join(archRel, d))).filter((d) => existsSync(join(src, d)));
    perTarget[t] = { sources, arch, defines, includeDirs: inc };
    files.add(`${archRel}/openssl.gypi`);
    for (const s of [...sources, ...arch]) files.add(s);
    // the generated headers
    for (const sub of ["include", "crypto", "providers/common/include"]) {
      const d = join(src, archRel, sub);
      if (!existsSync(d)) continue;
      for (const f of walk(d)) if (f.endsWith(".h")) files.add(rel(src, f));
    }
  }
  // every header under the source trees
  for (const t of SOURCE_TREES) for (const f of walk(join(src, "openssl", t))) if (/\.(h|inc)$/.test(f)) files.add(rel(src, f));
  // the .c files other files #include (transitively), resolved against the
  // includer's directory
  const queue = [...files].filter((f) => /\.(c|h|inc)$/.test(f));
  while (queue.length > 0) {
    const f = queue.pop();
    for (const m of readFileSync(join(src, f), "latin1").matchAll(/^\s*#\s*include\s*"([^"]+\.c)"/gm)) {
      const cand = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (existsSync(join(src, cand)) && !files.has(cand)) {
        files.add(cand);
        queue.push(cand);
      }
    }
  }
  const version = /MAJOR=(\d+)\nMINOR=(\d+)\nPATCH=(\d+)/.exec(readFileSync(join(src, "openssl/VERSION.dat"), "utf8"));
  if (version === null) throw new Error("VERSION.dat: unexpected shape");
  const ver = `${version[1]}.${version[2]}.${version[3]}`;
  // the module
  const first = perTarget[TARGETS[0]].sources;
  const commonSources = first.filter((s) => TARGETS.every((t) => perTarget[t].sources.includes(s)));
  const commonSet = new Set(commonSources);
  const q = (s) => JSON.stringify(s);
  const lines = [
    `/* GENERATED by scripts/vendor-openssl.mjs from Node ${NODE_TAG}'s deps/openssl`,
    ` * (commit ${NODE_COMMIT}) — do not edit; --check requires byte-identity.`,
    " *",
    " * The no-asm build of OpenSSL as Node's gyp describes it, per target",
    " * (config/archs/<target>/no-asm/openssl.gypi). Paths are relative to",
    " * packages/runtime/vendor/openssl. backend/openssl-build.ts compiles them. */",
    "",
    `/** \`process.versions.openssl\` of the Node the tree comes from. */`,
    `export const OPENSSL_VERSION = ${q(ver)};`,
    `export const OPENSSL_NODE_TAG = ${q(NODE_TAG)};`,
    `export const OPENSSL_NODE_COMMIT = ${q(NODE_COMMIT)};`,
    "",
    `export const OPENSSL_TARGETS = [${TARGETS.map(q).join(", ")}] as const;`,
    "export type OpensslTarget = (typeof OPENSSL_TARGETS)[number];",
    "",
    "/** openssl_common.gypi's include_dirs (after the target's own). */",
    `export const OPENSSL_COMMON_INCLUDE_DIRS: readonly string[] = [${common.map((d) => q(posix.normalize(d).replace(/\/$/, ""))).join(", ")}];`,
    "",
    "/** The library sources every target compiles (`openssl_sources`). */",
    "export const OPENSSL_COMMON_SOURCES: readonly string[] = [",
    ...commonSources.map((s) => `  ${q(s)},`),
    "];",
    "",
    "export interface OpensslTargetConfig {",
    "  /** sources beyond OPENSSL_COMMON_SOURCES: the target's generated C, and any `openssl_sources` entry not every target lists */",
    "  readonly extraSources: readonly string[];",
    "  /** `openssl_defines_<target>` */",
    "  readonly defines: readonly string[];",
    "  /** the gypi's include_dirs (those that exist), resolved */",
    "  readonly includeDirs: readonly string[];",
    "}",
    "",
    "export const OPENSSL_TARGET_CONFIG: Readonly<Record<OpensslTarget, OpensslTargetConfig>> = {",
    ...TARGETS.flatMap((t) => {
      const c = perTarget[t];
      const extra = [...c.sources.filter((s) => !commonSet.has(s)), ...c.arch];
      return [
        `  ${q(t)}: {`,
        `    extraSources: [${extra.map(q).join(", ")}],`,
        `    defines: [${c.defines.map(q).join(", ")}],`,
        `    includeDirs: [${c.includeDirs.map(q).join(", ")}],`,
        "  },",
      ];
    }),
    "};",
    "",
  ];
  return { files: [...files].sort(), module: lines.join("\n"), version: ver };
}

/** Writes the vendored tree (and the module) under `outRoot`/`moduleOut`. */
function emit(src, d, outRoot, moduleOut, nodeLicense) {
  rmSync(outRoot, { recursive: true, force: true });
  for (const f of d.files) {
    mkdirSync(dirname(join(outRoot, f)), { recursive: true });
    copyFileSync(join(src, f), join(outRoot, f));
  }
  copyFileSync(nodeLicense, join(outRoot, "LICENSE.node"));
  writeFileSync(moduleOut, d.module);
}

const work = mkdtempSync(join(tmpdir(), "tsinter-vendor-openssl-"));
try {
  let src;
  let nodeLicense;
  if (from !== undefined) {
    src = join(from, "deps/openssl");
    nodeLicense = join(from, "LICENSE");
  } else {
    src = fetchNode(join(work, "node"));
    nodeLicense = join(work, "node", "LICENSE");
  }
  const d = derive(src);
  if (!check) {
    emit(src, d, vendorOut, sourcesOut, nodeLicense);
    let bytes = 0;
    for (const f of walk(vendorOut)) bytes += statSync(f).size;
    console.log(`vendored OpenSSL ${d.version} from Node ${NODE_TAG}: ${d.files.length + 1} files, ${(bytes / 1048576).toFixed(2)} MiB -> ${rel(root, vendorOut)}`);
    console.log(`wrote ${rel(root, sourcesOut)}`);
  } else {
    const outRoot = join(work, "out");
    const moduleOut = join(work, "openssl-sources.ts");
    emit(src, d, outRoot, moduleOut, nodeLicense);
    const problems = [];
    const want = new Map(walk(outRoot).map((f) => [rel(outRoot, f), f]));
    const have = new Map(existsSync(vendorOut) ? walk(vendorOut).map((f) => [rel(vendorOut, f), f]) : []);
    const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
    for (const [f, p] of want) {
      const h = have.get(f);
      if (h === undefined) problems.push(`missing: ${f}`);
      else if (digest(h) !== digest(p)) problems.push(`differs from ${NODE_TAG}: ${f}`);
    }
    for (const f of have.keys()) if (!want.has(f)) problems.push(`not from the tag: ${f}`);
    if (!existsSync(sourcesOut) || readFileSync(sourcesOut, "utf8") !== readFileSync(moduleOut, "utf8")) problems.push(`stale: ${rel(root, sourcesOut)}`);
    if (problems.length > 0) {
      console.error(problems.slice(0, 50).join("\n"));
      if (problems.length > 50) console.error(`... and ${problems.length - 50} more`);
      process.exit(1);
    }
    console.log(`ok: ${want.size} vendored files and openssl-sources.ts are byte-identical to Node ${NODE_TAG}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
