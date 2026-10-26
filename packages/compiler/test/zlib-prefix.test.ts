/* The vendored zlib's symbol prefix (packages/runtime/src/scr_zlib_prefix.h):
 * every zlib and cpu_features global the native lanes link is scr_z_*, never
 * a plain zlib name (a system libz another library loads) and never
 * Chromium's Cr_z_* (a host that links Chromium's own zlib — an
 * engine-plugin embedder of a library archive). Two checks: the header is
 * exactly chromeconf.h's rename list respelled (drift), and nm over a real
 * executable and a real library archive finds no unprefixed or Cr_z_ name. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile, compileLibrary } from "../src/index.js";
import { runtimeSrcDir } from "../src/backend/cc.js";

const execFileAsync = promisify(execFile);
const vendorDir = join(runtimeSrcDir(), "..", "vendor", "zlib-chromium");
const EXTRA = ["riscv_cpu_enable_rvv", "riscv_cpu_enable_vclmul", "x86_cpu_enable_avx512"];

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-zlib-prefix-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function chromeconfNames(): Promise<string[]> {
  const src = await readFile(join(vendorDir, "chromeconf.h"), "utf8");
  return [...src.matchAll(/^#define (\S+) Cr_z_(\S+)$/gm)].map((m) => {
    expect(m[2]).toBe(m[1]);
    return m[1]!;
  });
}

/** Every symbol name nm prints (any kind, any binding), the platform's
 * leading underscore removed on Mach-O. */
async function symbols(path: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("nm", [path], { maxBuffer: 1 << 26 });
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const name = parts[parts.length - 1];
    if (parts.length < 2 || name === undefined || name.endsWith(":")) continue;
    names.add(process.platform === "darwin" && name.startsWith("_") ? name.slice(1) : name);
  }
  return names;
}

async function checkPrefixed(path: string): Promise<void> {
  const syms = await symbols(path);
  const plain = [...(await chromeconfNames()), ...EXTRA].filter((n) => syms.has(n));
  expect(plain, `unprefixed zlib names in ${path}`).toEqual([]);
  expect([...syms].filter((s) => s.startsWith("Cr_z_")), `Chromium-prefixed names in ${path}`).toEqual([]);
  for (const n of ["scr_z_deflate", "scr_z_inflate", "scr_z_adler32", "scr_z_x86_cpu_enable_avx512"]) {
    expect(syms.has(n), `${n} in ${path}`).toBe(true);
  }
}

const PROGRAM = `import { deflateSync, inflateSync } from "node:zlib";
export function zip(b: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(deflateSync(b)));
}
console.log(zip(new Uint8Array([1, 2, 3])).length);
`;

describe("the vendored zlib's own symbol prefix", () => {
  test("ZP-01 scr_zlib_prefix.h is chromeconf.h's rename list respelled scr_z_ (gzgetc aside) plus the three cpu_features globals", async () => {
    const hdr = await readFile(join(runtimeSrcDir(), "scr_zlib_prefix.h"), "utf8");
    const ours = [...hdr.matchAll(/^#define (\S+) scr_z_(\S+)$/gm)].map((m) => {
      expect(m[2]).toBe(m[1]);
      return m[1]!;
    });
    const want = [...(await chromeconfNames()).filter((n) => n !== "gzgetc"), ...EXTRA];
    expect(ours).toEqual(want);
  });

  for (const backend of ["c", "llvm"] as const) {
    test(`ZP-02 ${backend}: an executable carries no plain or Cr_z_ zlib name`, async () => {
      const dir = await mkdtemp(join(scratch, `${backend}-`));
      const entry = join(dir, "main.ts");
      await writeFile(entry, PROGRAM);
      const res = await compile(entry, { outPath: join(dir, "p"), outDir: dir, backend });
      if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join("; "));
      await checkPrefixed(res.binaryPath);
    }, 300000);
  }

  test("ZP-03 a library archive carries no plain or Cr_z_ zlib name", async () => {
    const dir = await mkdtemp(join(scratch, "lib-"));
    const entry = join(dir, "lib.ts");
    await writeFile(entry, PROGRAM.split("\n").slice(0, 4).join("\n") + "\n");
    const profilePath = join(dir, "profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        profile_format: 1,
        name: "zl",
        entry,
        emission: "llvm",
        abi: { prefix: "zl_", init_symbol: "zl_init", sink_register_symbol: "zl_set_panic_sink", collect_symbol: "zl_collect", result_reset_symbol: null },
        exports: [{ export: "zip", symbol: "zl_zip", params: ["bytes"], returns: "bytes" }],
      }),
    );
    const res = await compileLibrary({ profilePath, outDir: dir });
    if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join("; "));
    await checkPrefixed(res.archivePath);
  }, 300000);
});
