/* Perf unit P1 (docs/design/perf-coin-rush.md): four optimizations that
 * must change nothing observable —
 *   1. pooled string literals (emitter.ts pushStrLitInto),
 *   2. integer lowering + an inline ToInt32 (i32.ts, emitter.ts walkI32),
 *   3. the string-key lookup memo (maps.ts find),
 *   4. array-callback inlining (inline-hof.ts).
 *
 * Each fixture under fixtures/p1-perf runs under Node (spawned at test
 * time — the expected output is Node's, never typed by hand) and as a
 * compiled module on the wasm lane and on the wasm-native lane; stdout,
 * stderr and the exit code must match byte-for-byte.
 *
 * Besides the differential, each mechanism gets a direct check that it
 * actually fired on its fixture (a row that never reaches the mechanism
 * proves nothing): the i32 plan names the counters, the callback sites
 * are inlined, the literal pool exists. And SCRIPTC_WASM_LIT_CHECK=1
 * builds re-verify every pooled literal's code units at each use (a
 * writer that mutated a shared literal would trap). */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { exprRange, planI32 } from "../src/backend/wasm/i32.js";
import { inlineArrayCallbacks } from "../src/backend/wasm/inline-hof.js";
import type { IrExpr, IrModule } from "../src/ir/nodes.js";
import { deserializeModule } from "../src/ir/serialize.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const FIX = join(import.meta.dirname, "fixtures", "p1-perf");
const scratch = mkdtempSync(join(tmpdir(), "tsinter-p1-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const FIXTURES = readdirSync(FIX).filter((f) => f.endsWith(".ts")).sort();

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

function stage(name: string, lane: string): string {
  const dir = join(scratch, `${name}-${lane}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  writeFileSync(entry, readFileSync(join(FIX, name), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return entry;
}

async function check(name: string, backend: "wasm" | "wasm-native"): Promise<void> {
  const entry = stage(name, backend);
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, backend === "wasm" ? "p.wasm" : "program"), outDir: dir, backend });
  if (!res.ok) throw new Error(`${name} refused on ${backend}: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const node = nodeRun(entry);
  const got: Out = backend === "wasm"
    ? await runWasm(res.binaryPath!).then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode }))
    : await nativeRun(res.binaryPath!);
  expect(got, name).toEqual(node);
}

describe("P1: fixtures vs Node (wasm lane)", () => {
  test.for(FIXTURES)("%s", async (name) => {
    await check(name, "wasm");
  }, 120_000);
});

describe("P1: fixtures vs Node (wasm-native lane)", () => {
  test.for(FIXTURES)("%s", async (name) => {
    await check(name, "wasm-native");
  }, 600_000);
});

describe("P1: pooled literals are never written (SCRIPTC_WASM_LIT_CHECK)", () => {
  test.for(FIXTURES)("%s", async (name) => {
    // The emitter reads the flag at load time: a child process builds and
    // runs with it set.
    const entry = stage(name, "litcheck");
    const dir = join(entry, "..");
    const script = `
      import { compile } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "index.ts"))};
      const r = await compile(${JSON.stringify(entry)}, { outPath: ${JSON.stringify(join(dir, "p.wasm"))}, outDir: ${JSON.stringify(dir)}, backend: "wasm" });
      if (!r.ok) { console.error("refused"); process.exit(3); }
      const bytes = (await import("node:fs")).readFileSync(${JSON.stringify(join(dir, "p.wasm"))});
      const m = new WebAssembly.Module(bytes);
      const names = WebAssembly.Module.customSections(m, "name");
      console.log(names.length > 0 && Buffer.from(names[0]).includes(Buffer.from("%w.litCheck")) ? "checked" : "unchecked");
    `;
    const sfile = join(dir, "lit.mts");
    writeFileSync(sfile, script);
    const tsx = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [sfile], { encoding: "utf8", env: { ...process.env, SCRIPTC_WASM_LIT_CHECK: "1" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("checked");
    const got = await runWasm(join(dir, "p.wasm"));
    expect({ stdout: String(got.stdout), stderr: String(got.stderr), exitCode: got.exitCode }).toEqual(nodeRun(entry));
  }, 180_000);
});

async function irOf(name: string): Promise<IrModule> {
  const entry = stage(name, "ir");
  const dir = join(entry, "..");
  const res = await compile(entry, { outPath: join(dir, "p.wasm"), outDir: dir, backend: "wasm", emitIr: true });
  if (!res.ok || res.irPath === undefined) throw new Error(`${name}: no IR`);
  return deserializeModule(readFileSync(res.irPath, "utf8"));
}

describe("P1: the mechanisms fire on their fixtures", () => {
  test("i32: loop counters and int32-valued bindings get i32 slots, the rest don't", async () => {
    const plan = planI32(await irOf("i32-loops.ts"));
    const names = (fn: string): string[] => [...(plan.locals.get(fn)?.keys() ?? [])].map((id) => id.replace(/\.\d+$/, "")).sort();
    expect(names("sum")).toEqual(["i"]); // s accumulates an array read: f64
    expect(names("rsum")).toEqual(["i"]);
    expect(names("popcount")).toContain("b");
    expect(names("djb")).toEqual(["h", "i"]);
    expect(names("bound")).toEqual([]); // i <= a.length could pass 2^31 - 1
    expect(names("mixed")).toEqual(["i"]); // k = i * n: n is any number
    expect(plan.globals.has("%g.e.g")).toBe(true);
    expect(plan.globals.has("%g.e.big")).toBe(false); // big++ unguarded
  }, 120_000);

  test("i32: expression ranges (no -0, no fractions, no overflow)", () => {
    const loc = { file: "x", start: 0, end: 0 };
    const F = { kind: "f64" } as const;
    const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F, loc });
    const bin = (op: string, l: IrExpr, r: IrExpr): IrExpr => ({ kind: "bin", op, left: l, right: r, type: F, loc }) as IrExpr;
    const none = (): null => null;
    expect(exprRange(num(-0), none)).toBeNull();
    expect(exprRange(num(2.5), none)).toBeNull();
    expect(exprRange(bin("*", num(0), num(-1)), none)).toBeNull(); // -0
    expect(exprRange(bin("%", num(-4), num(2)), none)).toBeNull(); // -0
    expect(exprRange(bin("+", num(2147483647), num(1)), none)).toEqual({ lo: 2147483648, hi: 2147483648 });
    expect(exprRange(bin(">>>", num(-1), num(0)), none)).toEqual({ lo: 0, hi: 4294967295 });
    expect(exprRange(bin("&", num(-1), num(255)), none)).toEqual({ lo: 0, hi: 255 });
    expect(exprRange(bin("/", num(4), num(2)), none)).toBeNull();
  });

  test("callbacks: every arrow-literal site in the fixture is inlined", async () => {
    const mod = await irOf("cb-inline.ts");
    const before = JSON.stringify(mod).match(/"callee":"%arr\.(filter|map|every|some|find|findIndex|forEach|reduce)\.\d+"/g)?.length ?? 0;
    const after = inlineArrayCallbacks(mod as never) as unknown as IrModule;
    const left = JSON.stringify(after.functions.filter((f) => !f.name.startsWith("%arr."))).match(/"callee":"%arr\.(filter|map|every|some|find|findIndex|forEach|reduce)\.\d+"/g)?.length ?? 0;
    expect(before).toBeGreaterThan(40);
    expect(left).toBe(0);
    // the input module is not modified (emitIr and other consumers share it)
    expect(JSON.stringify(mod).match(/"callee":"%arr\.(filter|map|every|some|find|findIndex|forEach|reduce)\.\d+"/g)?.length ?? 0).toBe(before);
  }, 120_000);
});
