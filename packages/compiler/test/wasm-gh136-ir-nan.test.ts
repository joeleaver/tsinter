/* GH #136: `emitIr` refused any program whose IR holds a NaN number
 * literal with the internal error "IR contains NaN; refusing to
 * serialize" — the global `NaN`, a numeric switch (whose lowering has a
 * NaN sentinel) and the lowerer's own NaN answers all put one there. NaN
 * now rides the serializer's non-finite sentinel like ±Infinity and -0.
 *
 * Each row builds with emitIr, reads the IR file back through
 * deserializeModule (a NaN literal must survive the round trip), and runs
 * equal to Node (spawned at test time), on the wasm lane and, in the
 * second describe, on the wasm-native lane. */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { deserializeModule } from "../src/ir/serialize.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-gh136-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Row {
  id: string;
  /** The entry's source (main.ts), plus extra files beside it. */
  src: string;
  files?: Record<string, string>;
}

const ROWS: Row[] = [
  {
    id: "GH136-01 the global NaN",
    src: "const x: number = NaN;\nconsole.log(x, Number.isNaN(x), [x].includes(NaN));",
  },
  {
    id: "GH136-02 a switch over a number (the lowering's NaN sentinel)",
    src: `function f(n: number): string { switch (n) { case 1: return "a"; case 2: return "b"; default: return "z"; } }\nconsole.log(f(1), f(2), f(NaN), f(3));`,
  },
  {
    id: "GH136-03 a TypeScript program importing a JavaScript lib",
    src: `import { pick } from "./lib.js";\nfunction kind(n: number): string { switch (n) { case 0: return "zero"; default: return Number.isNaN(n) ? "nan" : "other"; } }\nconsole.log(kind(pick(0)), kind(pick(1)), kind(NaN));`,
    files: { "lib.js": "export function pick(i) { return i === 0 ? 0 : 5; }\n" },
  },
];

function write(row: Row, backend: string): string {
  const dir = join(scratch, `${row.id.split(" ")[0]}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, row.src + "\n");
  for (const [name, text] of Object.entries(row.files ?? {})) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return entry;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function nativeRun(path: string): Promise<Out> {
  try {
    const p = run(path, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

/** Does the IR hold a NaN number literal anywhere? */
function holdsNaN(n: unknown): boolean {
  if (typeof n === "number") return Number.isNaN(n);
  if (n === null || typeof n !== "object") return false;
  return Object.values(n as Record<string, unknown>).some(holdsNaN);
}

async function check(row: Row, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = write(row, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend, emitIr: true });
  if (!res.ok) throw new Error(`${row.id} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  expect(res.irPath, "emitIr wrote no IR file").toBeDefined();
  expect(holdsNaN(deserializeModule(readFileSync(res.irPath!, "utf8"))), `${row.id}: the IR keeps its NaN literal`).toBe(true);
  const node = nodeRun(entry);
  expect(node.exitCode).toBe(0);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, row.id).toEqual(node);
}

describe("GH #136: emitIr over IR holding NaN (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm");
  });
});

describe("GH #136: emitIr over IR holding NaN (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await check(row, "wasm-native");
  }, 600_000);
});
