/* The OpenSSL Node bundles, built for the native runner's host (design:
 * the OpenSSL units O1-O5; O1 = this recipe, nothing links it yet).
 *
 * The sources are Node v24.18.1's deps/openssl (OpenSSL 3.5.7), vendored
 * byte-identical under packages/runtime/vendor/openssl by
 * scripts/vendor-openssl.mjs, which also generates openssl-sources.ts from
 * Node's per-target no-asm openssl.gypi. Node builds them with gyp and no
 * perl/Configure; so does this recipe: one clang (or `zig cc`) compile per
 * TU with the defines Node's gyp gives the `openssl` target, packed into one
 * static archive (libssl + libcrypto + the default and legacy providers,
 * STATIC_LEGACY — Node's library is the same single unit).
 *
 * no-asm: value-identical to Node's asm build (the same algorithms, groups
 * and cipher lists; the asm files only replace bulk primitives), compiled
 * for every target with no assembler and no perl.
 *
 * Symbols: every global the archive defines is scr_ossl_*, so an embedder
 * that links its own OpenSSL or BoringSSL never collides with it. The name
 * list is generated (packages/runtime/src/scr_ossl_prefix.h, by
 * scripts/gen-openssl-prefix.mjs: nm over a "raw" build). OpenSSL's own TUs
 * are NOT preprocessed with it: a macro rename changes what OpenSSL's
 * preprocessor sees (`#ifndef md4_block_data_order` guards a definition;
 * e_old.c and cpuid.c `#undef` names and then define them; `__func__`, which
 * OpenSSL's error records carry, would read scr_ossl_*). Instead each TU is
 * compiled to LLVM IR exactly as Node's code reads, its global names are
 * renamed in the IR (`@SSL_new` → `@scr_ossl_SSL_new`), and the IR is
 * compiled to the object — objcopy's --redefine-sym, done the same way for
 * ELF, Mach-O and COFF. Code that CALLS the archive (the host's units, the
 * smoke test) compiles with opensslIncludeArgs(), which force-includes the
 * header: there the macro rename is BoringSSL's BORINGSSL_PREFIX technique
 * and our scr_zlib_prefix.h precedent. The build fails if the archive
 * defines any global outside the prefix (and
 * packages/compiler/test/openssl-vendor.test.ts runs nm over the archive and
 * a linked executable).
 *
 * Cache: vendor/.cache/openssl-<version>-<key>-<target>[-raw]/libnodessl.a,
 * keyed by the recipe (flags, defines, include dirs, the prefix header's
 * bytes), the compiler's version and the vendored tree's digest; built in a
 * private directory and published by rename only once whole, and reused
 * only when the archive matches the size and digest recorded beside it at
 * publish time (board #323's rule: a truncated archive left by a crashed
 * build is rebuilt, never linked). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CcDriver, runtimeSrcDir, targetPlatform } from "./cc.js";
import {
  OPENSSL_COMMON_INCLUDE_DIRS,
  OPENSSL_COMMON_SOURCES,
  OPENSSL_TARGET_CONFIG,
  OPENSSL_VERSION,
  type OpensslTarget,
} from "./openssl-sources.js";

const execFileAsync = promisify(execFile);

export function vendorOpensslDir(): string {
  return join(runtimeSrcDir(), "..", "vendor", "openssl");
}

/** The generated symbol-prefix header (scripts/gen-openssl-prefix.mjs). */
export function opensslPrefixHeader(): string {
  return join(runtimeSrcDir(), "scr_ossl_prefix.h");
}

/** Node's configuration for the produced binary's OS and CPU: the
 * SCRIPTC_TARGET triple's, else the host's. Android is Node's own mapping
 * (openssl_no_asm.gypi: arm64/x64 "linux", "android" → linux-*). A target
 * Node has no configuration for here refuses by name. */
export function opensslTargetFor(driver: CcDriver, host: { platform: string; arch: string } = process): OpensslTarget {
  let os: string;
  let cpu: string;
  if (driver.target === null) {
    os = host.platform;
    cpu = host.arch === "x64" ? "x86_64" : host.arch === "arm64" ? "aarch64" : host.arch;
  } else {
    os = targetPlatform(driver);
    const m = /^(x86_64|aarch64|arm64)\b/.exec(driver.target);
    cpu = m === null ? (driver.target.split("-")[0] ?? "") : m[1] === "arm64" ? "aarch64" : m[1]!;
  }
  const t: OpensslTarget | undefined =
    os === "linux"
      ? cpu === "x86_64" ? "linux-x86_64" : cpu === "aarch64" ? "linux-aarch64" : undefined
      : os === "darwin"
        ? cpu === "x86_64" ? "darwin64-x86_64-cc" : cpu === "aarch64" ? "darwin64-arm64-cc" : undefined
        : os === "win32" && cpu === "x86_64"
          ? "VC-WIN64A"
          : undefined;
  if (t === undefined) throw new Error(`OpenSSL: no vendored Node configuration for ${os}/${cpu} (${driver.target ?? "host"})`);
  return t;
}

/** Node's release MODULESDIR (OPENSSL_MODULES' default), as `strings` reads
 * it from the v24.18.1 linux-x64 node binary: openssl.gyp sets it to gyp's
 * build-tree path, `$(BUILDTYPE)` unexpanded by make. Only a dynamic
 * provider load reads it (the default and legacy providers are built in). */
const NODE_MODULESDIR = "/home/iojs/build/ws/out/$(BUILDTYPE)/obj.target/deps/openssl/lib/openssl-modules";

/** The defines Node's gyp gives the `openssl` target on `target`, in
 * gyp's order: openssl_no_asm.gypi (OPENSSL_NO_ASM), the arch gypi's
 * openssl_defines_<target>, openssl.gyp (OPENSSL_NO_HW, OPENSSL_API_COMPAT,
 * STATIC_LEGACY, MODULESDIR) and openssl_common.gypi's per-OS block. */
export function opensslDefines(target: OpensslTarget): string[] {
  const os =
    target.startsWith("linux")
      ? [`-DOPENSSLDIR="/etc/ssl"`, `-DENGINESDIR="/dev/null"`, "-DTERMIOS"]
      : target.startsWith("darwin")
        ? [`-DOPENSSLDIR="/System/Library/OpenSSL/"`, `-DENGINESDIR="/dev/null"`]
        : [
            `-DOPENSSLDIR="C:\\\\Program Files\\\\Common Files\\\\SSL"`,
            `-DENGINESDIR="NUL"`,
            "-DOPENSSL_SYS_WIN32",
            "-DWIN32_LEAN_AND_MEAN",
            "-DL_ENDIAN",
            "-D_CRT_SECURE_NO_DEPRECATE",
            "-DUNICODE",
            "-D_UNICODE",
          ];
  return [
    "-DOPENSSL_NO_ASM",
    ...OPENSSL_TARGET_CONFIG[target].defines.map((d) => `-D${d}`),
    "-DOPENSSL_NO_HW",
    "-DOPENSSL_API_COMPAT=0x10100001L",
    "-DSTATIC_LEGACY",
    `-DMODULESDIR="${NODE_MODULESDIR}"`,
    ...os,
  ];
}

/** Include dirs: the target's generated headers FIRST (so the forwarding
 * headers under openssl/include, which dispatch on predefined macros to
 * Node's config/*.h — not vendored — are never reached), then
 * openssl_common.gypi's. */
function opensslIncludeDirs(target: OpensslTarget): string[] {
  const v = vendorOpensslDir();
  return [...OPENSSL_TARGET_CONFIG[target].includeDirs, ...OPENSSL_COMMON_INCLUDE_DIRS].map((d) => join(v, d));
}

/** What a TU that CALLS the archive compiles with: the target's public
 * headers (generated ones first) and the prefix header, force-included. */
export function opensslIncludeArgs(target: OpensslTarget): string[] {
  const v = vendorOpensslDir();
  return ["-include", opensslPrefixHeader(), "-I", join(v, OPENSSL_TARGET_CONFIG[target].includeDirs.find((d) => d.endsWith("/include")) ?? ""), "-I", join(v, "openssl", "include")];
}

/** The C flags of every OpenSSL TU (besides defines and includes). -O2,
 * not gyp's -O3 (size; value-identical); per-function sections so a link
 * with --gc-sections can drop what the host never reaches; hidden
 * visibility so a shared-library flavor exports none of it; -w — the code
 * is OpenSSL's, its warnings are not ours. */
export function opensslCflags(driver: CcDriver, target: OpensslTarget): string[] {
  const win = target.startsWith("VC-");
  return [
    "-std=gnu11",
    ...driver.targetArgs,
    "-O2",
    "-w",
    "-ffunction-sections",
    "-fdata-sections",
    "-fvisibility=hidden",
    ...(win ? [] : ["-fPIC", "-pthread"]),
  ];
}

export function opensslSources(target: OpensslTarget): string[] {
  return [...OPENSSL_COMMON_SOURCES, ...OPENSSL_TARGET_CONFIG[target].extraSources];
}

const memo = new Map<string, Promise<string>>();
function once(key: string, f: () => Promise<string>): Promise<string> {
  let p = memo.get(key);
  if (p === undefined) {
    p = f();
    memo.set(key, p);
  }
  return p;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The vendored tree's digest: every file's path and bytes. */
export function opensslTreeDigest(): Promise<string> {
  return once("tree", async () => {
    const v = vendorOpensslDir();
    const h = createHash("sha256");
    for (const f of await walk(v)) h.update(f.slice(v.length)).update("\0").update(await readFile(f)).update("\0");
    return h.digest("hex");
  });
}

function compilerVersion(driver: CcDriver): Promise<string> {
  return once(`cc:${driver.argv.join(" ")}`, () =>
    execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), "--version"], { cwd: tmpdir() }).then((r) => r.stdout.split("\n", 1)[0] ?? ""),
  );
}

/** The archiver: `zig ar` under zig; llvm-ar when on PATH (it indexes any
 * object format — a host GNU ar cannot index a Mach-O or foreign-ELF
 * member), else the system ar. */
function archiver(driver: CcDriver): Promise<string[]> {
  if (driver.argv[0] === "zig") return Promise.resolve(["zig", "ar"]);
  return once("ar", () => execFileAsync("llvm-ar", ["--version"]).then(() => "llvm-ar", () => "ar")).then((a) => [a]);
}

const ARCHIVE = "libnodessl.a";

async function digestOf(p: string): Promise<string> {
  const b = await readFile(p);
  return `${b.length} ${createHash("sha256").update(b).digest("hex")}`;
}

/** an ar archive past its header that matches the size and digest recorded
 * beside it when it was published (#323) */
async function isWholeArchive(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    if (!st.isFile() || st.size < 68) return false;
    const b = await readFile(p);
    if (b.subarray(0, 8).toString("latin1") !== "!<arch>\n") return false;
    const recorded = await readFile(`${p}.ok`, "utf8");
    return recorded === `${b.length} ${createHash("sha256").update(b).digest("hex")}`;
  } catch {
    return false;
  }
}

/** Every name the archive renames: the header's `#define X scr_ossl_X`
 * lines, the commented-out ones included (names a public header maps to
 * another name, which a caller therefore never spells — evp.h's
 * EVP_aes_128_cfb → EVP_aes_128_cfb128 — but which OpenSSL still defines). */
export async function opensslPrefixNames(callersOnly = false): Promise<Set<string>> {
  const text = await readFile(opensslPrefixHeader(), "utf8");
  const re = callersOnly ? /^#define (\w+) scr_ossl_\1$/gm : /#define (\w+) scr_ossl_\1\b/gm;
  return new Set([...text.matchAll(re)].map((m) => m[1]!));
}

/** The IR with every global in `names` renamed scr_ossl_* — `@name` is how
 * LLVM IR spells a global (functions, variables, aliases; never a string's
 * contents, which are c"..." constants). */
export function renameIrGlobals(ir: string, names: ReadonlySet<string>): string {
  return ir.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (m, n: string) => (names.has(n) ? `@scr_ossl_${n}` : m));
}

/** The defined global names of an object or archive per `nm` (llvm-nm
 * when on PATH, which reads every object format; else the system nm), the
 * Mach-O leading underscore removed; null when no nm can read it. */
export async function definedGlobals(path: string, darwin: boolean): Promise<Set<string> | null> {
  for (const tool of ["llvm-nm", "nm"]) {
    try {
      const { stdout } = await execFileAsync(tool, ["-g", "--defined-only", "--format=just-symbols", path], { maxBuffer: 1 << 28 });
      const names = new Set<string>();
      for (const line of stdout.split("\n")) {
        const n = line.trim();
        if (n === "" || n.endsWith(":")) continue;
        names.add(darwin && n.startsWith("_") ? n.slice(1) : n);
      }
      return names;
    } catch {
      // the next tool
    }
  }
  return null;
}

export interface OpensslBuildOptions {
  /** false: build WITHOUT the rename (gen-openssl-prefix.mjs reads the raw
   * names from it); never linked into anything */
  prefix?: boolean;
  /** parallel compiles (default: SCRIPTC_OSSL_JOBS, else min(8, cpus)) */
  jobs?: number;
}

/** The cache directory's key for this recipe. */
export async function opensslRecipeKey(driver: CcDriver, target: OpensslTarget, prefix: boolean): Promise<string> {
  const h = createHash("sha256");
  h.update(`recipe 3\0${target}\0`);
  h.update([...opensslCflags(driver, target), ...opensslDefines(target), ...opensslIncludeDirs(target).map((d) => d.slice(vendorOpensslDir().length))].join("\x1f")).update("\0");
  h.update(prefix ? await readFile(opensslPrefixHeader()) : "raw").update("\0");
  h.update(driver.argv.join(" ")).update("\0").update(await compilerVersion(driver)).update("\0");
  h.update((await archiver(driver)).join(" ")).update("\0");
  h.update(await opensslTreeDigest());
  return h.digest("hex").slice(0, 16);
}

/** The static archive for the driver's target, built on first use (about
 * 1100 TUs) and cached. */
export async function ensureOpensslArchive(driver: CcDriver, opts: OpensslBuildOptions = {}): Promise<string> {
  const prefix = opts.prefix ?? true;
  const target = opensslTargetFor(driver);
  const key = await opensslRecipeKey(driver, target, prefix);
  const cacheRoot = join(runtimeSrcDir(), "..", "vendor", ".cache");
  const flavor = `${target}${driver.target !== null ? `-${driver.target}` : ""}${driver.argv[0] === "zig" ? "-zigcc" : ""}${prefix ? "" : "-raw"}`;
  const dir = join(cacheRoot, `openssl-${OPENSSL_VERSION}-${key}-${flavor}`);
  const archive = join(dir, ARCHIVE);
  if (await isWholeArchive(archive)) return archive;

  await mkdir(cacheRoot, { recursive: true });
  const build = await mkdtemp(join(cacheRoot, `build-openssl-${flavor}-`));
  try {
    const v = vendorOpensslDir();
    const cflags = opensslCflags(driver, target);
    const flags = [...cflags, ...opensslDefines(target), ...opensslIncludeDirs(target).flatMap((d) => ["-I", d])];
    // the IR's codegen half: the same optimisation level and codegen
    // options (the frontend half already fixed visibility, PIC level and
    // the language)
    const codegen = cflags.filter((f) => !f.startsWith("-std=") && f !== "-pthread" && !f.startsWith("-fvisibility"));
    const sources = opensslSources(target);
    const objName = (s: string): string => `${s.replace(/\.c$/, "").replace(/[/\\]/g, "__")}.o`;
    const envJobs = Number(process.env["SCRIPTC_OSSL_JOBS"] ?? "");
    const jobs = Math.max(1, opts.jobs ?? (Number.isInteger(envJobs) && envJobs > 0 ? envJobs : Math.min(8, availableParallelism())));
    const names = prefix ? await opensslPrefixNames() : null;
    const cc = (a: string[]): Promise<unknown> => execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), ...a], { cwd: build, maxBuffer: 64 << 20 });
    let next = 0;
    const failures: string[] = [];
    const worker = async (): Promise<void> => {
      while (next < sources.length && failures.length === 0) {
        const s = sources[next++]!;
        try {
          const obj = join(build, objName(s));
          if (names === null) {
            // one -c per invocation (zig's COFF driver rejects several)
            await cc([...flags, "-c", join(v, s), "-o", obj]);
          } else {
            // the frontend's unoptimised IR, renamed, then the optimiser
            // and codegen on it: the object -O2 compiles, its globals
            // spelled scr_ossl_*
            const ll = obj.replace(/\.o$/, ".ll");
            await cc([...flags, "-S", "-emit-llvm", "-Xclang", "-disable-llvm-passes", join(v, s), "-o", ll]);
            await writeFile(ll, renameIrGlobals(await readFile(ll, "utf8"), names));
            await cc([...codegen, "-c", ll, "-o", obj]);
            await rm(ll, { force: true });
          }
        } catch (err) {
          failures.push(`${s}:\n${(err as { stderr?: string }).stderr ?? String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));
    if (failures.length > 0) throw new Error(`OpenSSL (${target}): ${failures.length} TU(s) failed to compile; the first:\n${failures[0]}`);
    const objs = sources.map((s) => join(build, objName(s)));
    for (const o of objs) {
      const st = await stat(o).catch(() => null);
      if (st === null || st.size === 0) throw new Error(`OpenSSL (${target}): the compiler left no whole object for ${o}`);
    }
    const ar = await archiver(driver);
    await execFileAsync(ar[0]!, [...ar.slice(1), "rcs", join(build, ARCHIVE), ...objs], { cwd: build, maxBuffer: 16 << 20 });
    await Promise.all(objs.map((o) => rm(o, { force: true })));
    if (prefix) {
      // the prefix gate: no global the archive defines may escape it
      const defined = await definedGlobals(join(build, ARCHIVE), target.startsWith("darwin"));
      const plain = defined === null ? [] : [...defined].filter((n) => !n.startsWith("scr_ossl_")).sort();
      if (plain.length > 0) {
        throw new Error(`OpenSSL (${target}): the archive defines ${plain.length} global(s) outside the scr_ossl_ prefix (re-run scripts/gen-openssl-prefix.mjs with this target): ${plain.slice(0, 20).join(" ")}`);
      }
    }
    await writeFile(join(build, `${ARCHIVE}.ok`), await digestOf(join(build, ARCHIVE)));
    if (!(await isWholeArchive(join(build, ARCHIVE)))) throw new Error(`OpenSSL (${target}): the archiver left an archive that is not whole`);
    // publish: renamed into place; a whole archive published first by
    // another process stays; a broken one is moved aside, never removed in
    // place (#323)
    if (!(await rename(build, dir).then(() => true, () => false)) && !(await isWholeArchive(archive))) {
      const stale = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
      if (await rename(dir, stale).then(() => true, () => false)) {
        await rename(build, dir).catch(() => undefined);
        await rm(stale, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(build, { recursive: true, force: true });
  }
  if (!(await isWholeArchive(archive))) throw new Error(`OpenSSL (${target}): no whole archive at ${archive} after the build`);
  return archive;
}
