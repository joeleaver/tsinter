/* The wasm-native lane (native-runner phases N0-N1): a native executable
 * that IS the WasmGC backend's module, translated to C by wasm2c.ts (the
 * whole-program profile) and linked with the native runner — the collector,
 * the C host for abi.ts's imports, and the driver under
 * packages/runtime/src/wasmnative/. Node is the oracle through the module:
 * whatever the module does under V8, the executable does natively.
 *
 * Run beside the c and llvm lanes and compared against Node
 * (tests/harness/wasmnative-differential.test.ts); later phases replace
 * them with it (design: native = the wasm module + a C host).
 *
 * The runner's host provides the imports listed in NATIVE_HOST_IMPORTS, with
 * exactly these signatures — since phase N1 every import of abi.ts,
 * the event sources included (wn_ev.c, wn_cp.c, wn_net.c, wn_tls.c,
 * wn_fetch.c). A module importing anything else refuses to build on this
 * lane, naming the import: a LinkError's moment, moved to build time, never
 * a stub that fails late. The TLS and fetch units link only into a module
 * that imports tlsCall / fetch, with the vendored mbedTLS archive (and, for
 * fetch, the vendored zlib) behind them. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureTlsArchive, ensureZlibObjects, resolveCc, runtimeSrcDir } from "./cc.js";
import {
  IMPORT_CHDIR,
  IMPORT_CP_CALL,
  IMPORT_EV_POLL,
  IMPORT_EXIT,
  IMPORT_FETCH,
  IMPORT_FS_CALL,
  IMPORT_HOST_NUM,
  IMPORT_HOST_STR,
  IMPORT_KILL,
  IMPORT_NET_CALL,
  IMPORT_NOW,
  IMPORT_RANDOM,
  IMPORT_SEED,
  IMPORT_SIG_CALL,
  IMPORT_SLEEP,
  IMPORT_STDIN_CALL,
  IMPORT_TLS_CALL,
  IMPORT_TZ_CALL,
  IMPORT_UMASK,
  IMPORT_WALL_CLOCK,
  IMPORT_WATCH_CALL,
  IMPORT_WRITE,
} from "./wasm/abi.js";
import { type HostImportSig, wasmModuleToC } from "./wasm2c.js";

const execFileAsync = promisify(execFile);

const sig = (params: HostImportSig["params"], results: HostImportSig["results"]): HostImportSig => ({ params, results });

/** The imports the runner's host implements (every one of abi.ts's since
 * phase N1), by abi.ts name, with their wasm signatures (the host units
 * define host_<name> with the matching C types). */
export const NATIVE_HOST_IMPORTS: ReadonlyMap<string, HostImportSig> = new Map([
  [IMPORT_WRITE, sig(["i32", "i32", "i32"], [])],
  [IMPORT_NOW, sig([], ["f64"])],
  [IMPORT_SEED, sig([], ["i64"])],
  [IMPORT_WALL_CLOCK, sig([], ["f64"])],
  [IMPORT_HOST_STR, sig(["i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_HOST_NUM, sig(["i32", "i32"], ["f64"])],
  [IMPORT_EXIT, sig(["i32"], [])],
  [IMPORT_KILL, sig(["i32", "i32"], ["i32"])],
  [IMPORT_CHDIR, sig(["i32", "i32"], ["i32"])],
  [IMPORT_UMASK, sig(["i32", "i32"], ["i32"])],
  [IMPORT_FS_CALL, sig(["i32", "i32", "i32", "i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_RANDOM, sig(["i32", "i32"], [])],
  [IMPORT_SLEEP, sig(["f64"], [])],
  [IMPORT_TZ_CALL, sig(["i32", "f64", "i32", "i32"], ["f64"])],
  // N1: the event sources (wn_ev.c, wn_cp.c)
  [IMPORT_EV_POLL, sig(["i32", "i32"], ["i32"])],
  [IMPORT_CP_CALL, sig(["i32", "i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_SIG_CALL, sig(["i32", "i32"], ["i32"])],
  [IMPORT_WATCH_CALL, sig(["i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_STDIN_CALL, sig(["i32"], ["i32"])],
  [IMPORT_NET_CALL, sig(["i32", "i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_TLS_CALL, sig(["i32", "i32", "i32", "i32", "i32"], ["i32"])],
  [IMPORT_FETCH, sig(["i32", "i32", "i32", "i32", "i32"], ["i32"])],
]);

const WA = (globalThis as unknown as { WebAssembly: { validate: (b: Uint8Array) => boolean } }).WebAssembly;

/** The module translated for the runner (throws Wasm2cHostImportError for
 * an import the host lacks, Error for anything outside the translator's
 * subset). The translator assumes a VALID module (its types, its stack
 * discipline), so the module is validated first — by the engine the wasm
 * lane runs it on — and an invalid one refuses instead of translating. */
export function translateForNativeRunner(bytes: Uint8Array): string {
  if (!WA.validate(bytes)) throw new Error("wasm2c: the module does not validate");
  return wasmModuleToC(bytes, { hostImports: NATIVE_HOST_IMPORTS });
}

export function wasmNativeRuntimeDir(): string {
  return join(runtimeSrcDir(), "wasmnative");
}

/** The runner's C units, compiled once per flavor into objects. */
const RUNNER_SOURCES = ["wn_gc.c", "wn_host.c", "wn_main.c", "wn_ev.c", "wn_cp.c", "wn_net.c", "wn_tls.c", "wn_fetch.c"];
/** The units a module links only when it imports what they serve (the
 * translation declares `host_<import>` for each import it has): the TLS
 * engine (and the vendored mbedTLS archive behind it). */
const OPTIONAL_UNITS: readonly { obj: string; needs: RegExp }[] = [
  { obj: "wn_tls.o", needs: /\bhost_tlsCall\(/ },
  { obj: "wn_fetch.o", needs: /\bhost_fetch\(/ },
];
/** Everything the runner's objects and the translation include. */
const RUNNER_INPUTS = [
  "wasmnative/wn_rt.h",
  "wasmnative/wn_host.h",
  "wasmnative/wn_net.h",
  ...RUNNER_SOURCES.map((s) => `wasmnative/${s}`),
  "scr_zone_names.h",
  "scr_zlib_prefix.h",
];

let inputsHashMemo: Promise<string> | null = null;
function runnerInputsHash(): Promise<string> {
  inputsHashMemo ??= (async () => {
    const h = createHash("sha256");
    for (const f of RUNNER_INPUTS) h.update(f).update("\0").update(await readFile(join(runtimeSrcDir(), f))).update("\0");
    return h.digest("hex").slice(0, 16);
  })();
  return inputsHashMemo;
}

/** The C flags (wn_rt.h's header says why each): wasm's float semantics —
 * every operation runs, a NaN's bits included (-ffp-model=strict: no
 * algebraic folding, no contraction); the object model's casts (no strict
 * aliasing); a large frame probes its pages (-fstack-clash-protection), so
 * it cannot step over the stack's guard. `-w`: the translation is
 * machine-written; its warnings are not the user's. */
export function wasmNativeCflags(sanitize: boolean): string[] {
  return [
    "-std=gnu11",
    ...(sanitize ? ["-O1", "-g", "-fsanitize=undefined", "-fno-sanitize-recover=undefined"] : ["-O2"]),
    "-ffp-model=strict",
    "-fno-math-errno",
    "-fno-strict-aliasing",
    "-fstack-clash-protection",
    "-w",
  ];
}
const cflags = wasmNativeCflags;

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** The runner's objects for one flavor, cached under the runtime package's
 * vendor/.cache (atomic-rename publish, like the regex engine object). */
async function ensureRunnerObjects(sanitize: boolean): Promise<string[]> {
  const driver = resolveCc();
  if (driver.target !== null) throw new Error("the wasm-native lane does not cross-compile yet (SCRIPTC_TARGET is set)");
  const flavor = `${sanitize ? "ubsan" : "plain"}${driver.argv.length === 1 && driver.argv[0] === "clang" ? "" : "-zigcc"}`;
  const cacheRoot = join(runtimeSrcDir(), "..", "vendor", ".cache");
  // keyed by the inputs, the flags and the compiler that built them
  const key = createHash("sha256")
    .update(await runnerInputsHash())
    .update("\0")
    .update([...cflags(sanitize), ...driver.targetArgs].join("\x1f"))
    .update("\0")
    .update(await ccVersion())
    .digest("hex")
    .slice(0, 16);
  const dir = join(cacheRoot, `wasmnative-${key}-${flavor}`);
  const objs = RUNNER_SOURCES.map((s) => join(dir, s.replace(/\.c$/, ".o")));
  if ((await Promise.all(objs.map(exists))).every(Boolean)) return objs;
  await mkdir(cacheRoot, { recursive: true });
  const build = await mkdtemp(join(cacheRoot, `build-wasmnative-${flavor}-`));
  try {
    await Promise.all(
      RUNNER_SOURCES.map((s) =>
        execFileAsync(driver.argv[0] ?? "clang", [
          ...driver.argv.slice(1),
          ...cflags(sanitize),
          ...driver.targetArgs,
          `-I${join(runtimeSrcDir(), "..", "vendor", "mbedtls", "include")}`,
          `-I${join(runtimeSrcDir(), "..", "vendor", "zlib-chromium")}`,
          `-I${runtimeSrcDir()}`,
          "-c",
          join(wasmNativeRuntimeDir(), s),
          "-o",
          join(build, s.replace(/\.c$/, ".o")),
        ]),
      ),
    );
    await rename(build, dir).catch(() => undefined);
  } finally {
    await rm(build, { recursive: true, force: true });
  }
  return objs;
}

let ccVersionMemo: Promise<string> | null = null;
function ccVersion(): Promise<string> {
  const driver = resolveCc();
  ccVersionMemo ??= execFileAsync(driver.argv[0] ?? "clang", [...driver.argv.slice(1), "--version"], { cwd: tmpdir() }).then((r) => r.stdout.split("\n", 1)[0] ?? "");
  return ccVersionMemo;
}

function cacheRootDir(): string | null {
  if (process.env["SCRIPTC_NO_CACHE"] === "1") return null;
  const d = process.env["SCRIPTC_CACHE_DIR"];
  return d !== undefined && d !== "" ? d : null;
}


/** Compiles the translation and links it with the runner. With
 * SCRIPTC_CACHE_DIR set (the test lanes) an unchanged translation reuses
 * its cached executable (keyed by the compiler version, the runner's
 * inputs, the flags and the C bytes). */
export async function compileWasmNative(opts: { cPath: string; outPath: string; sanitize: boolean }): Promise<void> {
  const driver = resolveCc();
  const allObjs = await ensureRunnerObjects(opts.sanitize);
  const cText = await readFile(opts.cPath, "utf8");
  const wanted = new Set(OPTIONAL_UNITS.filter((u) => u.needs.test(cText)).map((u) => u.obj));
  const objs = allObjs.filter((o) => {
    const opt = OPTIONAL_UNITS.find((u) => o.endsWith(`/${u.obj}`));
    return opt === undefined || wanted.has(opt.obj);
  });
  // the TLS engine: the vendored mbedTLS archive (built once, cached; the
  // plain flavor — its objects carry no sanitizer runtime)
  const libs = [
    ...(wanted.has("wn_tls.o") || wanted.has("wn_fetch.o") ? [await ensureTlsArchive(false, driver)] : []),
    // fetch's content decoding: the vendored zlib Node bundles
    ...(wanted.has("wn_fetch.o") ? await ensureZlibObjects(false, driver) : []),
  ];
  const args = [
    ...driver.argv.slice(1),
    ...cflags(opts.sanitize),
    ...driver.targetArgs,
    `-I${wasmNativeRuntimeDir()}`,
    opts.cPath,
    ...objs,
    ...libs,
    "-o",
    opts.outPath,
    "-lpthread",
    "-lm",
  ];
  const root = cacheRootDir();
  let cached: string | null = null;
  if (root !== null) {
    const key = createHash("sha256")
      .update(await ccVersion())
      .update("\0")
      .update(await runnerInputsHash())
      .update("\0")
      .update(cflags(opts.sanitize).join("\x1f"))
      .update("\0")
      .update(await readFile(opts.cPath))
      .digest("hex");
    cached = join(root, "wnbin", key.slice(0, 2), key);
    if (await exists(cached)) {
      const tmp = `${opts.outPath}.${process.pid}.tmp`;
      await copyFile(cached, tmp);
      await rename(tmp, opts.outPath);
      const now = new Date();
      await utimes(cached, now, now).catch(() => undefined);
      return;
    }
  }
  await execFileAsync(driver.argv[0] ?? "clang", args, { maxBuffer: 64 << 20 });
  if (cached !== null) {
    await mkdir(join(cached, ".."), { recursive: true }).catch(() => undefined);
    const tmp = `${cached}.${process.pid}.tmp`;
    await copyFile(opts.outPath, tmp)
      .then(() => rename(tmp, cached))
      .catch(() => rm(tmp, { force: true }));
  }
}
