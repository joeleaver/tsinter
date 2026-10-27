/* Board #299: one-code-unit strings on the wasm tier come from a shared
 * single-character table (strings.ts %w.str.unit, V8's own cache), and
 * `[...s]` / `Array.from(s)` run as one pass (%w.str.chars). The bug this
 * pins: every charAt / `s[i]` / `split("")` / string-iterator step /
 * one-unit fromCharCode or slice allocated a fresh array, so walking a
 * big string per character churned millions of small arrays through the
 * GC and went super-linear above 1 MB (`[...s]` 312 ms at 4 MB, ×7 for
 * ×4 input; a charAt loop ×18; Node 24–40 ms).
 *
 * Two probes, both shaped to hold on a loaded box (best of several runs,
 * timed inside the program against the host's real clock):
 * - SCALING: each per-character walk at N and 4N code units must answer
 *   ≤ ×10 (linear is ≈ ×4–5; the churn measured ×7–×18).
 * - NODE PARITY for the two builtins Node fast-paths, split("") and the
 *   spread: within ×6 of Node running the same program at 4N (the churn
 *   measured ×13–×23; the table puts them at ×1–×2).
 * Every result — over ASCII, Latin-1, CJK, astral and lone-surrogate
 * subjects — is also compared with Node, so a fast wrong answer fails. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-onechar-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const N = 1024 * 1024;
const RUNS = 3;
const RATIO_BOUND = 10;
const NODE_BOUND = 6;
const NOISE_FLOOR_MS = 3;

/** [name, body over `s` answering a number, compared with Node]. */
const OPS: [string, string][] = [
  ["split('')", "{ const a = s.split(''); return a.length + a[a.length >> 1]!.charCodeAt(0); }"],
  ["[...s]", "{ const a = [...s]; return a.length + a[a.length >> 1]!.charCodeAt(0); }"],
  ["Array.from(s)", "{ const a = Array.from(s); return a.length + a[0]!.length; }"],
  ["for-of", "{ const a: string[] = []; for (const c of s) a.push(c); return a.length; }"],
  ["charAt", "{ const a: string[] = []; for (let i = 0; i < s.length; i++) a.push(s.charAt(i)); return a.length; }"],
  ["s[i]", "{ const a: string[] = []; for (let i = 0; i < s.length; i++) a.push(s[i]!); return a.length; }"],
  ["fromCharCode", "{ const a: string[] = []; for (let i = 0; i < s.length; i++) a.push(String.fromCharCode(s.charCodeAt(i))); return a.length; }"],
  ["slice(i, i+1)", "{ const a: string[] = []; for (let i = 0; i < s.length; i++) a.push(s.slice(i, i + 1)); return a.length; }"],
];
/** Ops Node runs as builtin fast paths — held to NODE_BOUND too. */
const NODE_PARITY = new Set([0, 1]);

function program(): string {
  const lines: string[] = [];
  lines.push("function subject(n: number): string {");
  lines.push("  let piece = 'h\\u00e9llo, w\\u00f6rld! The quick brown fox. ';");
  lines.push("  while (piece.length < 4096) piece = piece + piece;");
  lines.push("  const parts: string[] = [];");
  lines.push("  let len = 0;");
  lines.push("  while (len < n) { parts.push(piece); len += piece.length; }");
  lines.push("  return parts.join('').slice(0, n);");
  lines.push("}");
  OPS.forEach(([, body], i) => lines.push(`function op${i}(s: string): number ${body}`));
  lines.push(`const fs: ((s: string) => number)[] = [${OPS.map((_, i) => `op${i}`).join(", ")}];`);
  lines.push("function best(f: (s: string) => number, s: string): number {");
  lines.push("  let t = Infinity;");
  lines.push(`  for (let r = 0; r < ${RUNS}; r++) {`);
  lines.push("    const t0 = performance.now();");
  lines.push("    f(s);");
  lines.push("    const dt = performance.now() - t0;");
  lines.push("    if (dt < t) t = dt;");
  lines.push("  }");
  lines.push("  return t;");
  lines.push("}");
  // Exactness over every unit class: Latin-1, CJK, astral pairs, lone
  // halves (ordered both ways), U+0000/U+FFFF.
  lines.push("const odd: string[] = ['', 'a', '\\u00ff\\u0100', '\\u4e2d\\u6587x', '\\u{1F600}y\\u{1F601}', 'a\\ud800', '\\udc00\\ud800\\udc00b', '\\u0000\\uffff'];");
  lines.push("for (let u = 0; u < odd.length; u++) {");
  lines.push("  const s = odd[u]!;");
  lines.push("  console.log('X ' + u + ' ' + JSON.stringify([[...s], s.split(''), Array.from(s), s.charAt(0), s.slice(0, 1), String.fromCharCode(s.charCodeAt(0) | 0)]));");
  lines.push("}");
  lines.push(`const small = subject(${N});`);
  lines.push(`const big = subject(${4 * N});`);
  lines.push("for (let i = 0; i < fs.length; i++) {");
  lines.push("  console.log('T ' + i + ' ' + best(fs[i]!, small) + ' ' + best(fs[i]!, big));");
  lines.push("  console.log('R ' + i + ' ' + fs[i]!(small) + ' ' + fs[i]!(big));");
  lines.push("}");
  return lines.join("\n") + "\n";
}

test("#299 one-unit strings are shared: per-character walks scale linearly on wasm, and agree with Node", async () => {
  const entry = join(scratch, "onechar.ts");
  await writeFile(entry, program());
  const res = await compile(entry, { outPath: join(scratch, "onechar.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath, { imports: { now: () => performance.now() } });
  expect(run.stderr).toBe("");
  const out = run.stdout.split("\n");
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" }).split("\n");

  const timesOf = (lines: string[]): Map<number, [number, number]> =>
    new Map(
      lines
        .filter((l) => l.startsWith("T "))
        .map((l) => {
          const [, i, tn, t4n] = l.split(" ");
          return [Number(i), [Number(tn), Number(t4n)]];
        }),
    );
  const wasmT = timesOf(out);
  const nodeT = timesOf(node);
  expect(wasmT.size).toBe(OPS.length);

  const bad: string[] = [];
  for (const [i, [small, big]] of wasmT) {
    const name = OPS[i]![0];
    if (big >= NOISE_FLOOR_MS) {
      const ratio = big / Math.max(small, 0.05);
      if (ratio > RATIO_BOUND) bad.push(`${name}: ×${ratio.toFixed(1)} for ×4 input (${small.toFixed(1)} → ${big.toFixed(1)} ms)`);
    }
    const nodeBig = nodeT.get(i)![1];
    if (NODE_PARITY.has(i) && big >= NOISE_FLOOR_MS) {
      const vsNode = big / Math.max(nodeBig, 1);
      if (vsNode > NODE_BOUND) bad.push(`${name}: ×${vsNode.toFixed(1)} Node at ${4 * N} units (${big.toFixed(1)} vs ${nodeBig.toFixed(1)} ms)`);
    }
  }
  expect(bad).toEqual([]);
  const results = (lines: string[]): string[] => lines.filter((l) => l.startsWith("R ") || l.startsWith("X "));
  expect(results(out)).toEqual(results(node));
}, 300_000);
