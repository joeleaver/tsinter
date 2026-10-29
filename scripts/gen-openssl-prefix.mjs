#!/usr/bin/env node
/* Generates packages/runtime/src/scr_ossl_prefix.h — the vendored
 * OpenSSL's symbol prefix: one `#define X scr_ossl_X` for every global
 * symbol the no-asm libssl + libcrypto build defines. The archive
 * backend/openssl-build.ts builds renames exactly these names in every
 * OpenSSL TU's LLVM IR (so it defines and references only scr_ossl_*
 * names, and an embedder that links its own OpenSSL or BoringSSL never
 * collides with it); a TU that calls the archive force-includes the header
 * (BoringSSL's BORINGSSL_PREFIX technique; our scr_zlib_prefix.h
 * precedent — token-pasted names such as d2i_X509 are rescanned after
 * pasting, so they are renamed too).
 *
 * The list is MEASURED: the script builds the archive WITHOUT the rename
 * (the recipe's "raw" flavor, never linked into anything) for each target
 * it can build, and takes the union of `nm -g --defined-only` over them.
 *
 *   node scripts/gen-openssl-prefix.mjs --all          # rewrite the header: the host
 *                                                      # and every OPENSSL_PREFIX_TARGETS
 *                                                      # triple (zig cc for those)
 *   node scripts/gen-openssl-prefix.mjs --all --check  # require byte-identity
 *   node scripts/gen-openssl-prefix.mjs --target <triple> ...   # the host and these
 *
 * The header is generated over EVERY target the runner is built for (the
 * host plus backend/openssl-build.ts OPENSSL_PREFIX_TARGETS), so one header
 * serves them all: a name not every measured target defines (a Windows-only
 * store, say) carries a trailing `only:` comment naming the targets that
 * do (packages/compiler/test/openssl-vendor.test.ts holds each archive to
 * exactly that). A mingw `.refptr.<name>` is an indirection cell, never a
 * name (openssl-build.ts definedGlobals). Needs the compiler package built
 * (it runs the recipe from packages/compiler/dist); the recipe fails on any
 * target whose archive still defines an unprefixed global. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "packages/runtime/src/scr_ossl_prefix.h");
const args = process.argv.slice(2);
const check = args.includes("--check");
const { resolveCc } = await import(join(root, "packages/compiler/dist/backend/cc.js"));
const { OPENSSL_PREFIX_TARGETS, definedGlobals, ensureOpensslArchive, opensslTargetFor } = await import(join(root, "packages/compiler/dist/backend/openssl-build.js"));
const { OPENSSL_VERSION, OPENSSL_NODE_TAG } = await import(join(root, "packages/compiler/dist/backend/openssl-sources.js"));

const targets = args.includes("--all") ? [...OPENSSL_PREFIX_TARGETS] : args.flatMap((a, i) => (args[i - 1] === "--target" ? [a] : []));
// the host first (clang, or SCRIPTC_CC's driver), then each cross triple
// through zig cc
const drivers = [resolveCc({ ...process.env, SCRIPTC_TARGET: "" }), ...targets.map((t) => resolveCc({ ...process.env, SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: t }))];
const all = new Set();
const seen = [];
/** OpenSSL configuration → the names its archive defines */
const byTarget = new Map();
for (const driver of drivers) {
  const target = opensslTargetFor(driver);
  const archive = await ensureOpensslArchive(driver, { prefix: false });
  const names = await definedGlobals(archive, target.startsWith("darwin"));
  if (names === null) throw new Error("neither llvm-nm nor nm could read the archive");
  seen.push(`${target}${driver.target !== null ? ` (${driver.target})` : ""}: ${names.size}`);
  byTarget.set(target, names);
  for (const n of names) all.add(n);
}
const bad = [...all].filter((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
if (bad.length > 0) throw new Error(`unexpected symbol names: ${bad.slice(0, 10).join(" ")}`);
const sorted = [...all].sort();
// Names a PUBLIC header maps to another of these names (evp.h:
// `#define EVP_aes_128_cfb EVP_aes_128_cfb128`): a caller never spells
// them (the header's macro replaces ours, with a warning), but OpenSSL
// defines them (e_old.c), so the archive still renames them. They stay in
// the list, commented out for callers.
const mapped = new Map();
const pubDirs = [join(root, "packages/runtime/vendor/openssl/openssl/include/openssl")];
for (const driver of drivers) pubDirs.push(join(root, "packages/runtime/vendor/openssl/config/archs", opensslTargetFor(driver), "no-asm/include/openssl"));
for (const d of pubDirs) {
  for (const f of readdirSync(d).sort()) {
    if (!f.endsWith(".h")) continue;
    for (const m of readFileSync(join(d, f), "utf8").matchAll(/^\s*#\s*define\s+(\w+)[ \t]+(\w+)[ \t]*$/gm)) {
      if (all.has(m[1]) && all.has(m[2])) mapped.set(m[1], `${f}: ${m[2]}`);
    }
  }
}
// a name not every measured configuration defines names the ones that do
const only = (n) => {
  const have = [...byTarget].filter(([, s]) => s.has(n)).map(([t]) => t);
  return have.length === byTarget.size ? "" : ` /* only: ${have.join(" ")} */`;
};
const line = (n) => (mapped.has(n) ? `/* #define ${n} scr_ossl_${n} -- ${mapped.get(n)} */` : `#define ${n} scr_ossl_${n}${only(n)}`);
const text = `/* GENERATED by scripts/gen-openssl-prefix.mjs — do not edit; --check
 * requires byte-identity. The vendored OpenSSL's (${OPENSSL_VERSION}, Node ${OPENSSL_NODE_TAG}'s
 * deps/openssl) symbol prefix: every global its no-asm libssl + libcrypto
 * build defines, renamed scr_ossl_*, so an embedder's own OpenSSL or
 * BoringSSL never collides with it. backend/openssl-build.ts renames these
 * names in every OpenSSL TU's IR (OpenSSL's own sources never see this
 * header), and force-includes the header into every TU that calls the
 * archive (opensslIncludeArgs). The commented-out lines are names a public
 * header maps to another name, so a caller never spells them; the archive
 * renames them all the same. A trailing "only:" comment names the
 * configurations that define a name not all of them do. Measured with nm
 * over the targets:
 * ${seen.join("\n * ")}
 * (${sorted.length} names). packages/compiler/test/openssl-vendor.test.ts
 * holds every built archive and a linked executable to it. */
#ifndef SCR_OSSL_PREFIX_H
#define SCR_OSSL_PREFIX_H

${sorted.map(line).join("\n")}

#endif
`;
if (check) {
  let have = "";
  try {
    have = readFileSync(outPath, "utf8");
  } catch {
    // missing
  }
  if (have !== text) {
    console.error(`stale: ${outPath} (re-run scripts/gen-openssl-prefix.mjs --all)`);
    process.exit(1);
  }
  console.log(`ok: scr_ossl_prefix.h (${sorted.length} names)`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath}: ${sorted.length} names (${seen.join("; ")})`);
}
