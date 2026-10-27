/* Regex behavior that is scriptc-only by nature — deliberately NOT in the
 * differential corpus (tests/corpus/1200.. holds everything Node-comparable):
 *
 * - The one statefulness fence left after board #301 (lastIndex is
 *   modelled on every lane — corpus 2795/2796 pin it against Node):
 *   assert.throws's shape form over a global/sticky regex VALUE aborts by
 *   name, because Node runs a shape key's regex a second time when it
 *   reports a failed comparison.
 * - The two size/stability pins: a regex-free program must not reference
 *   the regex runtime at all (byte-identical link line — its C names no
 *   ScrRegex symbol), and a regex-USING static binary pays the regex
 *   engine (the wasm tier's, translated — scr_regex_engine.h) plus
 *   libunicode, never the ~620KB embedded-engine class: well under 300KB.
 * - A regex literal outside the tier refuses the native build by the wasm
 *   tier's own key (SEMANTICS.md S102).
 *
 * SCRIPTC_SAN=1 builds the programs with ASan + the RC audit.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const platformTest = process.env["SCRIPTC_PORTABLE_ONLY"] === "1" ? test.skip : test;

interface BuildResult {
  binaryPath: string;
  cPath: string;
}

/** Compiles an inline program (static by default — regex needs no flag). */
async function build(
  name: string,
  source: string,
  opts: { sanitize?: boolean } = {},
): Promise<BuildResult> {
  const san = opts.sanitize ?? sanitize;
  const key = createHash("sha256")
    .update(source)
    .update(san ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `regex-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  // Pinned: the size/stability pins below grep the emitted C (no ScrRegex
  // symbol) and weigh the C-lane binary — this suite measures the C
  // backend's artifact by design.
  const result = await compile(file, { outPath: join(outDir, name), outDir, sanitize: san, backend: "c" });
  if (!result.ok) {
    throw new Error(
      "regex program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return { binaryPath: result.binaryPath, cPath: result.cPath };
}

describe("regex (scriptc-only behavior)", () => {
  test("assert.throws's shape form aborts by name on a global/sticky regex VALUE (board #301)", async () => {
    // lastIndex is modelled (SEMANTICS.md S003's regex amendment), but
    // Node runs a shape key's regex a SECOND time when it reports a failed
    // comparison — one verdict cannot reproduce that, so a value-path g/y
    // regex in a shape key aborts by name (the wasm tier traps there too).
    // A literal at the call is a fresh object and stays Node-exact.
    const r = await build(
      "shape-re-sticky-value",
      `import assert from "node:assert";
assert.throws(() => { throw new Error("boom"); }, { message: /boom/y });
console.log("literal ok");
const re = /boom/y;
assert.throws(() => { throw new Error("boom"); }, { message: re });
console.log("unreachable");
`,
    );
    const err = await execFileAsync(r.binaryPath, []).then(
      () => {
        throw new Error("expected the value-path sticky shape regex to abort");
      },
      (e: Error & { signal?: string; stdout?: string; stderr?: string }) => e,
    );
    expect(err.signal).toBe("SIGABRT");
    expect(err.stdout).toBe("literal ok\n");
    expect(err.stderr).toContain("assert.throws with a shape key holding a global or sticky regex value is not supported");
  });

  test("a literal outside the tier refuses the build by the wasm tier's key", async () => {
    // tsc's parser (and V8) accept 300 capture groups; the one regex
    // compiler fences captures at 255 (SEMANTICS.md S102), and the native
    // lanes run it at build time over every literal, as the wasm tier does:
    // the build refuses by the same key — never a program that starts and
    // aborts at the regex's first use (the retired native behavior).
    const dir = join(cacheDir, "regex-literal-fence");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "main.ts");
    writeFileSync(file, `console.log("before");\nconsole.log(/${"(a)".repeat(300)}/.test("a"));\n`);
    for (const backend of ["c", "llvm"] as const) {
      const result = await compile(file, { outPath: join(dir, `p-${backend}`), outDir: dir, sanitize, backend });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((d) => d.code)).toEqual(["SC3001"]);
      expect(result.diagnostics[0]!.message).toContain("(expr:regexLit:too-many-captures)");
    }
  });

  // Linux /usr/bin/time reports the peak RSS; plain builds only (ASan's
  // quarantine holds freed memory by design).
  const memTest = !sanitize && process.platform === "linux" && existsSync("/usr/bin/time") ? platformTest : test.skip;
  memTest("a match loop's memory is bounded by one exec, not the sum of all of them", async () => {
    // Review B1 (unit D): the regex engine's collector ran only at the end
    // of an entry point, so every exec of one global replace kept its
    // allocations (subject-sized backtrack stacks included) until the loop
    // ended — 326 MB for the first program, 1.5 GB at 12,000 units for the
    // second (Node: 193 MB and 62 MB). The loop now collects between execs.
    const peakMb = async (bin: string): Promise<number> => {
      const { stderr } = await execFileAsync("/usr/bin/time", ["-f", "%M", bin], { maxBuffer: 1 << 26 });
      return Number(stderr.trim().split("\n").pop()) / 1024;
    };
    const many = await build("mem-many-execs", `const s = "a1 ".repeat(1000000);\nconst r = s.replace(/\\d/g, "#");\nconsole.log(r.length);\n`);
    const deep = await build("mem-deep-execs", `const s = "ab".repeat(6000);\nconst r = s.replace(/(?:a|b)*?x|a/g, "#");\nconsole.log(r.length);\n`);
    expect(await peakMb(many.binaryPath)).toBeLessThan(64);
    expect(await peakMb(deep.binaryPath)).toBeLessThan(32);
  });

  platformTest("regex-free programs never reference the regex runtime; regex use stays in its size class", async () => {
    // Measured on plain (non-ASan) builds. A regex-free program's C names
    // no ScrRegex symbol, so its link line is the historical one (the
    // compact static size class is pinned by island.test.ts). A regex-USING
    // binary links libregexp + libunicode, but must stay far below the
    // embedded-engine size class.
    const [plainBuild, regexBuild] = await Promise.all([
      build("size-plain", `console.log("hello", "world");\n`, { sanitize: false }),
      build(
        "size-regex",
        `console.log("a-b c".replace(/[-\\s]/g, "_"), /\\p{L}+/u.test("héllo"));\n`,
        { sanitize: false },
      ),
    ]);
    const plainC = readFileSync(plainBuild.cPath, "utf8");
    expect(plainC).not.toContain("ScrRegex");
    expect(plainC).not.toContain("scr_regex");
    // The class bounds are page-granular (macOS rounds segments to 16KB,
    // so a few hundred bytes of new runtime can tip a whole page): the net
    // loop hooks, the console/process/child surface (the piped-stream
    // slice included — scr_child.c is always linked), the
    // fs-scandir/Math-static slice, the path.win32 port, and the Buffer
    // numeric/encoding/search families (~11KB of always-linked bytes
    // runtime) each cost pages — regex linkage would be a ~110KB jump
    // above the static class, the engine a ~620KB one. The regex class
    // carries scr_assert.c (the regex link switch has always pulled it),
    // so the assert.throws shape machinery — the Comparison diff renderer
    // and the throws/rejects helpers — re-based it by a page, and the
    // dyn-assert machinery (the compact:false dyn renderer plus the real
    // myers line-diff printer) re-based it by another; the primitive-
    // prototype formatters (toExponential/toFixed0, Date.UTC, String.raw)
    // re-based the static class by one more; the ambient-receiver stack,
    // the %j dyn stringify walk, and the runtime-encoding readFileSync
    // form (all in always-linked TUs) tipped the regex class one more
    // page.
    // board #146: an ABSOLUTE bound on either binary drifts with the
    // toolchain (the canonical Sandbox clang measures 387,600 bytes plain
    // / 540,232 regex-linked; this tree's Ubuntu clang 21.1.8 measures
    // 396,272 plain / 553,264 regex-linked, this session) — the axis this
    // test actually guards is REGEX ACCIDENTALLY LINKED INTO A
    // REGEX-FREE PROGRAM, a ~153KB-ish jump (measured this session:
    // 553,264 − 396,272 = 156,992 bytes), not a byte count. The assertion
    // is RELATIVE instead: a program that uses regex must cost a
    // regex-sized jump over a regex-free one, and the regex build must
    // stay strictly bigger; a toolchain's page-granular drift (a few KB)
    // can never satisfy this floor.
    const plainSize = statSync(plainBuild.binaryPath).size;
    const regexSize = statSync(regexBuild.binaryPath).size;
    const REGEX_SIZE_FLOOR = 100_000; // bytes; measured jump ~157KB this session
    expect(regexSize - plainSize).toBeGreaterThan(REGEX_SIZE_FLOOR);
    expect(plainSize).toBeLessThan(regexSize);
  });
});
