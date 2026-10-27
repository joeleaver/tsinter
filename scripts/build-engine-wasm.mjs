#!/usr/bin/env node
/* Builds the WasmGC tier's engine module — quickjs-ng at the vendored pin
 * plus packages/runtime/src/wasm/isl_core.c, linked against wasi-libc with
 * `wasm-ld --emit-relocs` — into the CHECKED-IN artifact
 * packages/runtime/vendor/quickjs-ng-wasm/engine.wasm (+ engine.wasm.sha256).
 * The wasm emitter splices that artifact into a program's module only when
 * the program reaches the engine (packages/compiler/src/backend/wasm/
 * engine.ts), re-indexing it in place through the relocation sections, so
 * a compile never needs clang or wasi-libc. This script is the maintainer
 * half: run it after changing isl_core.c, the island sources it shares with
 * the native island (packages/runtime/src/scr_web_prelude.h — the web
 * globals; wasm-island-engine.test.ts goes red when the artifact's copy is
 * stale — scr_island_math.h, scr_jsmath.h, scr_ieee754.cc), or bumping the
 * vendored engine or vendor/v8-ieee754.
 *
 *   node scripts/build-engine-wasm.mjs           # rebuild the artifact
 *   node scripts/build-engine-wasm.mjs --check   # rebuild into a temp dir
 *                                                # and require byte-identity
 *
 * Three generated files, all checked in and all compared by --check:
 * - packages/runtime/src/wasm/node_globals.h — every own property name of a
 *   fresh Node CommonJS global (this script runs `process.execPath` on a
 *   one-line script), the candidate list for the engine's fence of the
 *   Node globals it lacks (SEMANTICS.md S103 (b)). It follows the Node
 *   that runs this script: the pinned Node 24 (v24.18.1 at this writing).
 * - vendor/quickjs-ng-wasm/engine.wasm (+ .sha256) — the engine.
 * - vendor/quickjs-ng-wasm/engine-fence.json — the names the built engine
 *   actually fences (node_globals.h minus what the engine has, the web
 *   prelude's globals included), read from
 *   the engine itself; the compiler's build-time fence uses it.
 *
 * Toolchain (Ubuntu packages, nothing else): clang-21 + wasm-ld-21
 * (llvm 21.1.x), wasi-libc 0.0~git20250726.3f7eb4c (sysroot
 * /usr/lib/wasm32-wasi, headers /usr/include/wasm32-wasi) and
 * libclang-rt-21-dev-wasm32 (the wasm32 compiler-rt builtins). The merger
 * depends on wasm-ld 21's --emit-relocs output shape (5-byte padded index
 * LEBs); engine.ts refuses an artifact whose shape differs, by name.
 *
 * Two traps this script steps around, both measured:
 * - The clang DRIVER silently runs `wasm-opt` when one is on PATH
 *   (~/.cargo/bin/wasm-opt here), and binaryen rewrites the code section
 *   without updating the relocations — the artifact is then corrupt in a
 *   way only the merger notices. So: compile with `clang -c` (no driver
 *   link step) under a pinned PATH, and call wasm-ld directly.
 * - wasm-ld's default 64KiB shadow stack sits BELOW the data, so an
 *   overflow silently corrupts static data. `--stack-first` puts it at the
 *   bottom of memory (an overflow traps out of bounds) and `-z stack-size`
 *   sizes it well above isl_core.c's ISL_STACK_BUDGET. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const vendor = join(root, "packages/runtime/vendor/quickjs-ng");
const outDir = join(root, "packages/runtime/vendor/quickjs-ng-wasm");
const coreDir = join(root, "packages/runtime/src/wasm");
const coreSrc = join(coreDir, "isl_core.c");
// The shared web prelude (scr_web_prelude.h) lives beside the native runtime.
const runtimeSrc = join(root, "packages/runtime/src");
const ieeeVendor = join(root, "packages/runtime/vendor/v8-ieee754");
const CLANG = "/usr/bin/clang-21";
const WASM_LD = "/usr/bin/wasm-ld-21";
const SYSROOT_LIB = "/usr/lib/wasm32-wasi";
const BUILTINS = "/usr/lib/llvm-21/lib/clang/21/lib/wasi/libclang_rt.builtins-wasm32.a";
const SHADOW_STACK = 1024 * 1024;
const ENGINE_SOURCES = ["dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];
// The flags native's engine archive uses (cc.ts buildEngineArchiveCross:
// gnu11, -funsigned-char, QUICKJS_NG_BUILD, _GNU_SOURCE, hidden
// visibility, NDEBUG), at -Oz: the artifact ships inside every
// engine-carrying module, so size wins over native's MinSizeRel -Os.
const CFLAGS = [
  "--target=wasm32-wasi",
  "-std=gnu11",
  "-funsigned-char",
  "-DQUICKJS_NG_BUILD",
  "-D_GNU_SOURCE",
  "-fvisibility=hidden",
  "-Oz",
  "-DNDEBUG",
  // Deterministic objects: no absolute paths may reach the output.
  "-fno-ident",
  "-ffile-prefix-map=" + root + "=.",
];
const env = { ...process.env, PATH: "/usr/bin:/bin" };

/** node_globals.h: Node's own global names, as a JS array literal macro. */
function nodeGlobalsHeader(dir) {
  const probe = join(dir, "globals.cjs");
  writeFileSync(probe, "process.stdout.write(JSON.stringify([Object.getOwnPropertyNames(globalThis).sort(), Object.keys(globalThis).sort()]));\n");
  const [names, enumerable] = JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8" }));
  for (const n of names) if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unexpected global name ${n}`);
  const macro = (list) => {
    const lines = [];
    for (let i = 0; i < list.length; i += 8) lines.push("  \"" + list.slice(i, i + 8).map((n) => `'${n}'`).join(",") + (i + 8 < list.length ? "," : "") + "\"");
    return "  \"[\" \\\n" + lines.join(" \\\n") + " \\\n  \"]\"\n";
  };
  return (
    "/* GENERATED by scripts/build-engine-wasm.mjs — do not edit. Every own\n" +
    ` * property name of a fresh Node ${process.version} CommonJS global: the candidate\n` +
    " * list for the island's fence of the Node globals it lacks (the web\n" +
    " * prelude's fenceGlobals, SEMANTICS.md S103 (b)), and the enumerable\n" +
    " * ones (a replaced fence takes Node's enumerability). */\n" +
    "#define ISL_NODE_GLOBALS \\\n" + macro(names) +
    "#define ISL_NODE_GLOBALS_ENUMERABLE \\\n" + macro(enumerable)
  );
}

/** The names the built engine fences, read from the engine itself. */
async function fenceList(bytes) {
  let mem = null;
  const wasi = {
    clock_time_get: (_i, _p, out) => {
      new DataView(mem.buffer).setBigUint64(out, 0n, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: () => 0,
    fd_seek: () => 70,
    fd_write: () => 0,
  };
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi, tsinter_engine: { math_random: () => 0.5, random: () => {}, pow: Math.pow, tz_offset: () => 0, tz_name: () => 0, perf_now: () => 0 } });
  mem = instance.exports.memory;
  instance.exports._initialize();
  const p = instance.exports.isl_fence_list();
  const u8 = new Uint8Array(mem.buffer);
  let end = p;
  while (u8[end] !== 0) end++;
  const names = new TextDecoder().decode(u8.subarray(p, end)).split(",").filter((n) => n.length > 0);
  return JSON.stringify({ fenced: names }, null, 1) + "\n";
}

function build(dir) {
  const objs = [];
  for (const src of [...ENGINE_SOURCES.map((s) => join(vendor, s)), coreSrc]) {
    const obj = join(dir, src.split("/").pop().replace(/\.c$/, ".o"));
    execFileSync(CLANG, [...CFLAGS, "-I", vendor, "-I", dir, "-I", runtimeSrc, "-c", src, "-o", obj], { env, stdio: "inherit" });
    objs.push(obj);
  }
  // V8's ieee754.cc — the ONE vendored copy every lane runs (SEMANTICS.md
  // S100) — through the native lanes' own wrapper, scr_ieee754.cc, with
  // cc.ts ensureIeee754Object's C++ flags (no C++ library: the shims stand
  // in for the headers it includes; -ffp-contract=off), at -Oz.
  const ieeeObj = join(dir, "scr_ieee754.o");
  execFileSync(
    CLANG,
    [
      "-x", "c++",
      "--target=wasm32-wasi",
      "-std=c++17",
      "-nostdinc++",
      "-Oz",
      "-DNDEBUG",
      "-ffp-contract=off",
      "-fno-exceptions",
      "-fno-rtti",
      "-fno-math-errno",
      "-fvisibility=hidden",
      "-fno-ident",
      "-ffile-prefix-map=" + root + "=.",
      "-I", join(ieeeVendor, "shim"),
      "-I", ieeeVendor,
      "-c", join(runtimeSrc, "scr_ieee754.cc"),
      "-o", ieeeObj,
    ],
    { env, stdio: "inherit" },
  );
  objs.push(ieeeObj);
  const out = join(dir, "engine.wasm");
  execFileSync(
    WASM_LD,
    [
      "-m", "wasm32",
      "-L" + SYSROOT_LIB,
      join(SYSROOT_LIB, "crt1-reactor.o"),
      "--entry", "_initialize",
      "--emit-relocs",
      "--strip-debug",
      "--stack-first",
      "-z", "stack-size=" + SHADOW_STACK,
      ...objs,
      "-lc",
      BUILTINS,
      "-o", out,
    ],
    { env, stdio: "inherit" },
  );
  return readFileSync(out);
}

const check = process.argv.includes("--check");
const tmp = mkdtempSync(join(tmpdir(), "engine-wasm-"));
try {
  const header = nodeGlobalsHeader(tmp);
  // The build always compiles against the header generated NOW (in the
  // temp dir, ahead of the checked-in copy on the include path).
  writeFileSync(join(tmp, "node_globals.h"), header);
  const bytes = build(tmp);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const fence = await fenceList(bytes);
  if (check) {
    const problems = [];
    if (readFileSync(join(coreDir, "node_globals.h"), "utf8") !== header) problems.push("node_globals.h differs from this Node's globals");
    const have = readFileSync(join(outDir, "engine.wasm"));
    if (Buffer.compare(have, bytes) !== 0) {
      problems.push(`engine.wasm: rebuilt ${sha}, checked in ${createHash("sha256").update(have).digest("hex")}`);
    }
    if (readFileSync(join(outDir, "engine-fence.json"), "utf8") !== fence) problems.push("engine-fence.json differs");
    if (problems.length > 0) {
      console.error(`NOT reproducible: ${problems.join("; ")}`);
      process.exit(1);
    }
    console.log(`engine.wasm, node_globals.h and engine-fence.json reproduce byte-identically (${bytes.length} bytes, sha256 ${sha})`);
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(coreDir, "node_globals.h"), header);
    writeFileSync(join(outDir, "engine.wasm"), bytes);
    writeFileSync(join(outDir, "engine.wasm.sha256"), `${sha}  engine.wasm\n`);
    writeFileSync(join(outDir, "engine-fence.json"), fence);
    console.log(`wrote engine.wasm (${bytes.length} bytes, sha256 ${sha}), node_globals.h, engine-fence.json`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
