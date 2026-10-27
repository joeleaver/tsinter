/* Board #291: global regex replace, and the string paths under it, must
 * scale LINEARLY on the wasm tier. The bug this pins: `%w.vec.join`
 * accumulated its result with one %w.concat per element, copying
 * everything built so far each time — O(total × pieces) — and a global
 * replace's result IS a join of its pieces, so `s.replace(/x/gu, …)` over
 * 1 MB did not finish in 25 minutes (64 KB ≈ 3 s, 128 KB ≈ 45 s; Node
 * does 1 MB in milliseconds).
 *
 * The probe is a SCALING RATIO, not an absolute time, so it holds on a
 * loaded box: each operation runs over a subject of N and of 4N code
 * units, best of several runs each (a load spike or a GC pause inflates
 * a run, never deflates one), timed inside the program against a real
 * clock the test host supplies. Linear work answers ≈ 4× (a little more
 * as the GC's live set grows); the quadratic join answered ≥ 16× — at
 * these sizes the old build measured 30–60×. The bound sits between
 * them, generous on the linear side. Below a noise floor (the 4N run
 * under 3 ms) a ratio is not meaningful and is not checked: the old,
 * quadratic build was far above that floor at every size used here.
 *
 * Every result is also compared with Node running the same program
 * (the timings are printed on their own lines and left out of the
 * comparison), so a fast wrong answer fails too. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-scaling-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const N = 64 * 1024;
const RUNS = 5;
const RATIO_BOUND = 10;
const NOISE_FLOOR_MS = 3;
/** A run of N this slow is the quadratic path at work: report it instead
 * of spending minutes on the 4N run. */
const SLOW_N_MS = 250;

/** [name, body over `s` answering a number]. */
const OPS: [string, string][] = [
  ["replace /a/g", "s.replace(/a/g, 'X').length"],
  ["replace /a/gu", "s.replace(/a/gu, 'X').length"],
  ["replace /./gu", "s.replace(/./gu, 'Y').length"],
  ["replace /\\s+/gu $&", "s.replace(/\\s+/gu, '[$&]').length"],
  ["replace /(\\w)(\\w*)/g $2$1", "s.replace(/(\\w)(\\w*)/g, '$2$1').length"],
  ["replaceAll /c/gu", "s.replaceAll(/c/gu, 'Z').length"],
  ["matchAll /(\\w)\\w*/gu", "{ let n = 0; for (const m of s.matchAll(/(\\w)\\w*/gu)) n += m[1]!.length; return n; }"],
  ["split /,\\s*/u", "s.split(/,\\s*/u).length"],
  ["split/join", "s.split(' ').join('-').length"],
  ["join numbers", "{ const a: number[] = []; for (let i = 0; i < s.length; i += 4) a.push(i); return a.join(',').length; }"],
];

function program(): string {
  const lines: string[] = [];
  lines.push("const units: string[] = ['abc def gh, ', '\\u{1F600}a\\u{1F601}b \\u{1F602}c, ', '\\u03b1\\u03b2 d\\u00e9f, '];");
  lines.push("function subject(unit: string, n: number): string {");
  lines.push("  let piece = unit;");
  lines.push("  while (piece.length < 4096) piece = piece + piece;");
  lines.push("  const parts: string[] = [];");
  lines.push("  let len = 0;");
  lines.push("  while (len < n) { parts.push(piece); len += piece.length; }");
  lines.push("  return parts.join('').slice(0, n);");
  lines.push("}");
  OPS.forEach(([, body], i) => {
    lines.push(`function op${i}(s: string): number ${body.startsWith("{") ? body : `{ return ${body}; }`}`);
  });
  lines.push("function best(f: (s: string) => number, s: string): number {");
  lines.push("  let t = Infinity;");
  lines.push(`  for (let r = 0; r < ${RUNS}; r++) {`);
  lines.push("    const t0 = performance.now();");
  lines.push("    f(s);");
  lines.push("    const dt = performance.now() - t0;");
  lines.push("    if (dt < t) t = dt;");
  lines.push(`    if (dt > ${SLOW_N_MS}) break;`);
  lines.push("  }");
  lines.push("  return t;");
  lines.push("}");
  lines.push(`const fs: ((s: string) => number)[] = [${OPS.map((_, i) => `op${i}`).join(", ")}];`);
  lines.push("for (let u = 0; u < units.length; u++) {");
  lines.push(`  const small = subject(units[u]!, ${N});`);
  lines.push(`  const big = subject(units[u]!, ${4 * N});`);
  lines.push("  for (let i = 0; i < fs.length; i++) {");
  lines.push("    const tn = best(fs[i]!, small);");
  lines.push(`    const slow = tn > ${SLOW_N_MS};`);
  lines.push("    const t4n = slow ? -1 : best(fs[i]!, big);");
  lines.push("    console.log('T ' + u + ' ' + i + ' ' + tn + ' ' + t4n);");
  lines.push("    console.log('R ' + u + ' ' + i + ' ' + fs[i]!(small) + ' ' + (slow ? 'skipped' : fs[i]!(big)));");
  lines.push("  }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

test("#291 global replace and the string paths under it scale linearly on wasm, and agree with Node", async () => {
  const entry = join(scratch, "scaling.ts");
  await writeFile(entry, program());
  const res = await compile(entry, { outPath: join(scratch, "scaling.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath, { imports: { now: () => performance.now() } });
  expect(run.stderr).toBe("");
  const out = run.stdout.split("\n");
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" }).split("\n");

  const bad: string[] = [];
  const timings = out.filter((l) => l.startsWith("T "));
  expect(timings.length).toBe(3 * OPS.length);
  for (const line of timings) {
    const [, u, i, tn, t4n] = line.split(" ");
    const name = `${OPS[Number(i)]![0]} [unit ${u}]`;
    const small = Number(tn);
    const big = Number(t4n);
    if (big < 0) {
      bad.push(`${name}: ${small.toFixed(0)} ms at ${N} code units — the quadratic path`);
      continue;
    }
    if (big < NOISE_FLOOR_MS) continue;
    const ratio = big / Math.max(small, 0.05);
    if (ratio > RATIO_BOUND) bad.push(`${name}: ×${ratio.toFixed(1)} for ×4 input (${small.toFixed(2)} → ${big.toFixed(2)} ms)`);
  }
  expect(bad).toEqual([]);
  expect(out.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
});
