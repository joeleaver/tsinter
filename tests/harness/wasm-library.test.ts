/* Library mode on the WasmGC lane (docs/design/wasm-library-mode.md §8.1):
 * each row under tests/library-wasm/ is a game-shaped program with exported
 * entry points and host imports, plus a drive script that calls them. It
 * runs three ways and every observable line must match byte for byte:
 *
 *   - node:     Node runs the TypeScript; the host module resolves to the
 *               test host (libmode/host.mjs) through a loader hook — the
 *               oracle;
 *   - v8:       the compiled module, instantiated with the same host;
 *   - wasmtime: the compiled module under wasmtime 47's C API with the host
 *               ported to C (libmode/host.c). Skipped by name when no
 *               wasmtime 47 is installed (scripts/cloud-setup.sh).
 *
 * A row's files:
 *   main.ts       the entry: its `export function`s are the module's exports
 *   *.d.ts        `declare module "<host>"` — the host modules
 *   profile.json  optional (format 2): classes, report sink, limits
 *   drive.txt     the call script (libmode/driver.mjs's header)
 *   expect.txt    optional: the expected output where Node cannot be the
 *                 oracle (a registered divergence, SEMANTICS.md S140–S144);
 *                 both engines must print exactly it
 *   refuse.txt    optional: `<code> <message substring>` — the build must
 *                 refuse with it (an out-of-tier row); nothing runs. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "@tsinter/compiler";

const here = dirname(fileURLToPath(import.meta.url));
const rowsDir = join(here, "..", "library-wasm");
const libmode = join(here, "libmode");
const work = join(tmpdir(), `tsinter-libmode-${process.pid}`);
mkdirSync(work, { recursive: true });

/** wasmtime 47 (CLI dir with include/ and lib/ beside bin/): SCRIPTC_WASMTIME_DIR,
 * else the `wasmtime` on PATH when its tree carries the C API. */
function findWasmtime(): string | null {
  const fromEnv = process.env["SCRIPTC_WASMTIME_DIR"];
  const candidates: string[] = fromEnv !== undefined && fromEnv !== "" ? [fromEnv] : [];
  for (const p of (process.env["PATH"] ?? "").split(":")) if (p !== "") candidates.push(join(p, ".."));
  for (const dir of candidates) {
    if (!existsSync(join(dir, "lib", "libwasmtime.a")) || !existsSync(join(dir, "include", "wasmtime.h"))) continue;
    try {
      const v = execFileSync(join(dir, "bin", "wasmtime"), ["--version"], { encoding: "utf8" });
      if (v.startsWith("wasmtime 47.")) return dir;
    } catch {
      continue;
    }
  }
  return null;
}
const WASMTIME = findWasmtime();
const NO_WASMTIME = "environment: no wasmtime 47 with its C API (scripts/cloud-setup.sh installs it; SCRIPTC_WASMTIME_DIR points at one)";

/** The wasmtime column's host binary, built once per host.c content. */
let hostBin: string | null = null;
function wasmtimeHost(): string {
  if (hostBin !== null) return hostBin;
  const src = join(libmode, "host.c");
  const hash = createHash("sha256").update(readFileSync(src)).digest("hex").slice(0, 16);
  const out = join(tmpdir(), `tsinter-libmode-host-${hash}`);
  if (!existsSync(out)) {
    const cc = process.env["CC"] ?? "clang";
    execFileSync(cc, ["-O1", "-Wall", "-Werror", "-o", `${out}.tmp`, src, `-I${join(WASMTIME!, "include")}`, join(WASMTIME!, "lib", "libwasmtime.a"), "-lpthread", "-ldl", "-lm"], { stdio: "inherit" });
    execFileSync("mv", [`${out}.tmp`, out]);
  }
  hostBin = out;
  return out;
}

interface Contract {
  exports: { name: string; params: string[]; result: string | null; constant?: true }[];
  imports: { module: string; name: string; params: string[]; result: string | null; role?: string }[];
  alloc: string | null;
  report: { module: string; name: string } | null;
  maxDepth: number;
}

function hostModules(row: string): string[] {
  const profile = join(row, "profile.json");
  if (existsSync(profile)) return Object.keys((JSON.parse(readFileSync(profile, "utf8")) as { imports?: object }).imports ?? {});
  const out = new Set<string>();
  for (const f of readdirSync(row)) {
    if (!f.endsWith(".d.ts")) continue;
    for (const m of readFileSync(join(row, f), "utf8").matchAll(/declare\s+module\s+"([^"]+)"/g)) out.add(m[1]!);
  }
  return [...out];
}

function runNode(row: string, contractPath?: string): string {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-transform-types", "--import", join(libmode, "loader.mjs"), join(libmode, "driver.mjs"), "node", row, join(row, "main.ts"), join(row, "drive.txt"), ...(contractPath !== undefined ? [contractPath] : [])],
    { encoding: "utf8", env: { ...process.env, LIBMODE_HOSTS: hostModules(row).join(",") }, maxBuffer: 64 << 20 },
  );
  if (r.status !== 0) throw new Error(`node column failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

function runV8(row: string, wasm: string, contractPath: string): string {
  const r = spawnSync(process.execPath, ["--no-warnings", join(libmode, "driver.mjs"), "v8", row, wasm, join(row, "drive.txt"), contractPath], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error(`v8 column failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

function runWasmtime(row: string, wasm: string, contract: Contract, dir: string): string {
  const lines = contract.imports.map((i) => `import ${i.module} ${i.name} ${i.params.length > 0 ? i.params.join(",") : "-"} ${i.result ?? "-"}`);
  if (contract.alloc !== null) lines.push(`alloc ${contract.alloc}`);
  const txt = join(dir, "contract.txt");
  writeFileSync(txt, lines.join("\n") + "\n");
  const r = spawnSync(wasmtimeHost(), [wasm, join(row, "drive.txt"), txt], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`wasmtime column failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

const rows = readdirSync(rowsDir).filter((n) => existsSync(join(rowsDir, n, "main.ts"))).sort();

describe("library mode: rows match Node on V8 and wasmtime", () => {
  for (const name of rows) {
    const row = join(rowsDir, name);
    const refuse = existsSync(join(row, "refuse.txt")) ? readFileSync(join(row, "refuse.txt"), "utf8").trim() : null;
    const expectFile = join(row, "expect.txt");
    it(name, async () => {
      const dir = join(work, name);
      mkdirSync(dir, { recursive: true });
      const profile = join(row, "profile.json");
      const res = await compile(join(row, "main.ts"), {
        backend: "wasm",
        outPath: join(dir, "m.wasm"),
        outDir: dir,
        library: existsSync(profile) ? { profilePath: profile } : {},
      });
      if (refuse !== null) {
        const sp = refuse.indexOf(" ");
        const [code, text] = [refuse.slice(0, sp), refuse.slice(sp + 1)];
        expect(res.ok, "an out-of-tier row must refuse").toBe(false);
        if (res.ok) return;
        expect(res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")).toContain(`${code} `);
        expect(res.diagnostics.some((d) => d.code === code && d.message.includes(text)), res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")).toBe(true);
        return;
      }
      if (!res.ok) throw new Error(res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
      const contract = res.library as Contract;
      const contractPath = join(dir, "contract.json");
      writeFileSync(contractPath, JSON.stringify(contract));
      const want = existsSync(expectFile) ? readFileSync(expectFile, "utf8") : runNode(row, contractPath);
      expect(runV8(row, res.binaryPath, contractPath)).toBe(want);
      if (WASMTIME !== null) expect(runWasmtime(row, res.binaryPath, contract, dir)).toBe(want);
    });
  }
  it.skipIf(WASMTIME !== null)(`wasmtime column: ${NO_WASMTIME}`, () => {});
});
