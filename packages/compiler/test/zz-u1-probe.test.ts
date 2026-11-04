/* LOCAL PROBE (not committed): compile listed corpus programs for wasm and
 * diff against Node. U1_FILES = comma-separated corpus-relative paths. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const corpus = join(import.meta.dirname, "../../../tests/corpus");
const scratch = mkdtempSync(join(process.env["U1_SCRATCH"] ?? tmpdir(), "u1p-"));
const files = (process.env["U1_FILES"] ?? "").split(",").filter(Boolean);

test.for(files)("%s", async (rel) => {
  const file = join(corpus, rel);
  const dynamic = readFileSync(file, "utf8").split("\n", 2).some((l) => /^\/\/ @dynamic\s*$/.test(l));
  const dir = join(scratch, rel.replace(/\W/g, "_"));
  const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
  let w: { stdout: unknown; exitCode: number };
  try {
    w = await runWasm(res.binaryPath);
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    const t = await runWasmToTrap(res.binaryPath);
    w = { stdout: t.stdout, exitCode: 1 };
    if (process.env["U1_SHOW"]) console.log("U1OUT stdout:\n" + t.stdout + "\nstderr:\n" + t.stderr);
  }
  const n = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "", cwd: join(file, "..") });
  if (w.stdout !== "(trap: stdout not captured)") expect(String(w.stdout)).toBe(n.stdout);
  expect(w.exitCode).toBe(n.status);
});
