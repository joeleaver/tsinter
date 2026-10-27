/* Unit H (SEMANTICS.md S115): mutating a typed array through its island
 * VIEW must scale LINEARLY on the wasm tier. The bug this pins: every
 * mutating method call snapshotted the whole array and wrote it back, so
 * N pushes cost O(N²) — 20 000 pushes took 23.5 s (c 49 ms, Node 72 ms).
 * push/pop, index writes, `length` truncation and the callback walkers now
 * run in place through the view's accessors.
 *
 * A SCALING RATIO, not an absolute time (the wasm-string-scaling.test.ts
 * method): each operation runs at N and 4N, best of several runs, timed
 * inside the program against the host's real clock; linear work answers
 * ≈ 4×, the quadratic path ≥ 16×. Results are compared with Node. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-view-scaling-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const N = 8000;
const RUNS = 3;
const RATIO_BOUND = 10;
const NOISE_FLOOR_MS = 3;
const SLOW_N_MS = 400;

/** [name, body over a fresh typed `xs` of n elements viewed as `v`, answering a number]. */
const OPS: [string, string][] = [
  ["push", "{ const ys: number[] = []; const w: any = ys; for (let i = 0; i < n; i++) w.push(i); return ys.length; }"],
  ["pop", "{ let s = 0; while (v.length > 0) s += v.pop(); return s; }"],
  ["index write", "{ for (let i = 0; i < n; i++) v[i] = i * 2; return xs[n - 1]!; }"],
  ["index read", "{ let s = 0; for (let i = 0; i < n; i++) { const e: number = v[i]; s += e; } return s; }"],
  ["forEach", "{ let s = 0; v.forEach((e: number) => { s += e; }); return s; }"],
  ["map", "{ return v.map((e: number) => e + 1).length; }"],
  ["length truncate", "{ for (let i = n; i > 0; i--) v.length = i - 1; return xs.length; }"],
];

function program(): string {
  const lines: string[] = ["// @dynamic"];
  OPS.forEach(([, body], i) => {
    lines.push(`function op${i}(n: number): number {`);
    lines.push("  const xs: number[] = [];");
    lines.push("  for (let i = 0; i < n; i++) xs.push(i);");
    lines.push("  const v: any = xs;");
    lines.push(`  return (() => ${body})();`);
    lines.push("}");
  });
  lines.push("function best(f: (n: number) => number, n: number): number {");
  lines.push("  let t = Infinity;");
  lines.push(`  for (let r = 0; r < ${RUNS}; r++) {`);
  lines.push("    const t0 = performance.now();");
  lines.push("    f(n);");
  lines.push("    const dt = performance.now() - t0;");
  lines.push("    if (dt < t) t = dt;");
  lines.push(`    if (dt > ${SLOW_N_MS}) break;`);
  lines.push("  }");
  lines.push("  return t;");
  lines.push("}");
  lines.push(`const fs: ((n: number) => number)[] = [${OPS.map((_, i) => `op${i}`).join(", ")}];`);
  lines.push("for (let i = 0; i < fs.length; i++) {");
  lines.push(`  const tn = best(fs[i]!, ${N});`);
  lines.push(`  const slow = tn > ${SLOW_N_MS};`);
  lines.push(`  const t4n = slow ? -1 : best(fs[i]!, ${4 * N});`);
  lines.push("  console.log('T ' + i + ' ' + tn + ' ' + t4n);");
  lines.push(`  console.log('R ' + i + ' ' + fs[i]!(${N}) + ' ' + (slow ? 'skipped' : fs[i]!(${4 * N})));`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

test("H-SCALE-01 view mutations and walks scale linearly on wasm, and agree with Node", async () => {
  const entry = join(scratch, "view-scaling.ts");
  await writeFile(entry, program());
  const res = await compile(entry, { outPath: join(scratch, "view-scaling.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath, { imports: { now: () => performance.now() } });
  expect(run.stderr).toBe("");
  const out = run.stdout.split("\n");
  const node = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", entry], { encoding: "utf8" }).split("\n");
  const bad: string[] = [];
  const timings = out.filter((l) => l.startsWith("T "));
  expect(timings.length).toBe(OPS.length);
  for (const line of timings) {
    const [, i, tn, t4n] = line.split(" ");
    const name = OPS[Number(i)]![0];
    const small = Number(tn);
    const big = Number(t4n);
    if (big < 0) {
      bad.push(`${name}: ${small.toFixed(0)} ms at ${N} elements — the quadratic path`);
      continue;
    }
    if (big < NOISE_FLOOR_MS) continue;
    const ratio = big / Math.max(small, 0.05);
    if (ratio > RATIO_BOUND) bad.push(`${name}: ×${ratio.toFixed(1)} for ×4 input (${small.toFixed(2)} → ${big.toFixed(2)} ms)`);
  }
  expect(bad).toEqual([]);
  expect(out.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
});
