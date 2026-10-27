/* Strings unit S2: string ACCUMULATION must scale linearly on the wasm
 * tier. Before concatenation nodes (ropes.ts) every `a + b` copied both
 * operands into a fresh array, so `s += "a"` to N units was O(N²):
 * 64K appends took over a second and 256K close to a minute, where Node
 * (whose ConsString makes the append O(1)) takes milliseconds. The shapes
 * pinned here are the ones real programs accumulate with: a one-unit and
 * a word append to a local, a template-literal append, a class-field
 * accumulator (`this.buf += …`), a closure-captured accumulator, an array
 * element, a prepend (`s = x + s`), and an accumulation through a
 * conditional or a comma expression (their arms are values too). Each answers its result's length
 * and a code unit, so the final flatten is inside the timing.
 *
 * The probe is the same SCALING RATIO as wasm-string-scaling.test.ts —
 * best of several runs at N and at 4N, timed inside the program against
 * the host's clock: linear work answers ≈ 4×, the old quadratic path
 * ≥ 16×; the bound sits between them. Below a noise floor a ratio is not
 * checked. Every result is compared with Node running the same program. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-rope-scaling-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const N = 64 * 1024;
const RUNS = 5;
const RATIO_BOUND = 10;
const NOISE_FLOOR_MS = 3;
/** A run of N this slow is the quadratic path at work. */
const SLOW_N_MS = 250;

/** [name, function body over `n` answering a number]. */
const OPS: [string, string][] = [
  ['s += "a"', 'let s = ""; for (let i = 0; i < n; i++) s += "a"; return s.length + s.charCodeAt(n - 1);'],
  ['s += "word" + i + " "', 'let s = ""; let i = 0; while (s.length < n) { s += "word" + i + " "; i++; } return s.length + s.charCodeAt(s.length - 2);'],
  ["s += `${i},${i * 2};`", 'let s = ""; let i = 0; while (s.length < n) { s += `${i},${i * 2};`; i++; } return s.length + s.charCodeAt(s.length - 2);'],
  ["this.buf += x", 'const o = new Out(); let i = 0; while (o.buf.length < n) { o.emit("line " + i + "\\n"); i++; } return o.buf.length + o.buf.charCodeAt(5);'],
  ["captured += x", 'let s = ""; const add = (x: string): void => { s += x; }; for (let i = 0; i < n; i += 4) add("abcd"); return s.length + s.charCodeAt(n - 1);'],
  ["a[0] = a[0] + x", 'const a: string[] = [""]; for (let i = 0; i < n; i += 2) a[0] = a[0]! + "xy"; return a[0]!.length + a[0]!.charCodeAt(1);'],
  ["s = c ? s + x : y + s", 'let s = ""; for (let i = 0; i < n; i++) s = i % 3 === 0 ? s + "ab" : "c" + s; return s.length + s.charCodeAt(5);'],
  ["s = (k++, s + x)", 'let s = ""; let k = 0; for (let i = 0; i < n; i++) s = (k++, s + "x"); return s.length + k + s.charCodeAt(1);'],
  ['s = "a" + s','let s = ""; for (let i = 0; i < n; i++) s = (i % 10) + s; return s.length + s.charCodeAt(0);'],
];

function program(): string {
  const lines: string[] = [];
  lines.push('class Out { buf = ""; emit(x: string): void { this.buf += x; } }');
  OPS.forEach(([, body], i) => lines.push(`function op${i}(n: number): number { ${body} }`));
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

test("S2 string accumulation (+=, templates, fields, captures, elements, prepend) scales linearly on wasm, and agrees with Node", async () => {
  const entry = join(scratch, "ropes.ts");
  await writeFile(entry, program());
  const res = await compile(entry, { outPath: join(scratch, "ropes.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath, { imports: { now: () => performance.now() } });
  expect(run.stderr).toBe("");
  const out = run.stdout.split("\n");
  const node = execFileSync(process.execPath, [entry], { encoding: "utf8" }).split("\n");

  const bad: string[] = [];
  const timings = out.filter((l) => l.startsWith("T "));
  expect(timings.length).toBe(OPS.length);
  for (const line of timings) {
    const [, i, tn, t4n] = line.split(" ");
    const name = OPS[Number(i)]![0];
    const small = Number(tn);
    const big = Number(t4n);
    if (big < 0) {
      bad.push(`${name}: ${small.toFixed(0)} ms at ${N} code units — the quadratic path`);
      continue;
    }
    if (big < NOISE_FLOOR_MS) continue;
    const ratio = big / Math.max(small, 0.05);
    if (ratio > RATIO_BOUND) bad.push(`${name}: ${small.toFixed(1)} ms → ${big.toFixed(1)} ms (×${ratio.toFixed(1)}) for 4× the length`);
  }
  expect(bad).toEqual([]);
  expect(out.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
}, 300_000);
