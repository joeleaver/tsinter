/* Strings unit S3: loops that EAT a string from the front must scale
 * linearly on the wasm tier. Before slice views (slices.ts) every
 * `s.slice(n)` copied the rest of the string, so a loop that consumes
 * its input a token at a time — `s = s.slice(1)`, a regex tokenizer's
 * `src = src.slice(m[0].length)` — was O(N²): 256K units took 20-40 s
 * where Node (whose SlicedString makes the slice O(1)) takes
 * milliseconds. The shapes pinned here: a `slice(1)` loop reading
 * charCodeAt(0), a regex tokenizer over a local, the same tokenizer in a
 * class field, a tokenizer that hands the rest to a helper function (the
 * parameter is read in place, not copied on entry), a substring/
 * startsWith/indexOf scanner, a trimStart loop, and split pieces read
 * back. Each answers a checksum, so the work is inside the timing.
 *
 * The probe is wasm-rope-scaling.test.ts's: the best of several runs at
 * N and at 4N, timed inside the program against the host's clock —
 * linear work answers ≈ 4×, the old quadratic path ≥ 16×; the bound sits
 * between them. Below a noise floor a ratio is not checked. Every result
 * is compared with Node running the same program. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-slice-scaling-"));
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

const LINE = "let x = 12 + foo(bar, 3);\\n";

/** [name, function body over `n` answering a number]. */
const OPS: [string, string][] = [
  ["s = s.slice(1)", 'let s = "ab".repeat(n / 2); let k = 0; while (s.length > 0) { k += s.charCodeAt(0); s = s.slice(1); } return k;'],
  [
    "src = src.slice(m[0].length)",
    `let src = "${LINE}".repeat(Math.ceil(n / 26)); let toks = 0; let w = 0; while (src.length > 0) { const m = /^(\\s+|\\w+|.)/.exec(src); src = src.slice(m![0].length); toks++; w += m![0].length; } return toks * 7 + w;`,
  ],
  [
    "this.src = this.src.slice(k)",
    `const lx = new Lexer("${LINE}".repeat(Math.ceil(n / 26))); let toks = 0; let h = 0; for (let t = lx.next(); t !== ""; t = lx.next()) { toks++; h = (h * 31 + t.charCodeAt(0)) % 1000003; } return toks + h;`,
  ],
  [
    "rest = step(rest)",
    `let rest = "${LINE}".repeat(Math.ceil(n / 26)); let k = 0; while (rest.length > 0) { k += rest.charCodeAt(0); rest = step(rest); } return k;`,
  ],
  [
    "substring/startsWith/indexOf",
    `let s = "${LINE}".repeat(Math.ceil(n / 26)); let k = 0; while (s.length > 0) { if (s.startsWith("let ")) k += 3; const i = s.indexOf(";"); k += i; s = s.substring(i < 0 ? s.length : i + 1); } return k;`,
  ],
  ["s = s.trimStart().slice(1)", 'let s = " a  b".repeat(n / 4); let k = 0; while (s.length > 0) { s = s.trimStart(); if (s.length > 0) k += s.charCodeAt(0); s = s.slice(1); } return k;'],
  // S2's accumulation in a module that holds views: a binding read only
  // by window readers must not flatten its rope at every write.
  ['s += "ab"; s.indexOf(q)', 'let s = ""; for (let i = 0; i < n; i += 2) s += "ab"; return s.indexOf("q") + s.length;'],
  ['s += "ab"; /q/.test(s)', 'let s = ""; for (let i = 0; i < n; i += 2) s += "ab"; return (/q/.test(s) ? 1 : 0) + s.length;'],
  ["template-built param, charCodeAt", 'let s = ""; let i = 0; while (s.length < n) { s += `${i},`; i++; } return readEvery(s);'],
  ["p += x in a callee, then charCodeAt", "return grow(n);"],
  [
    "split pieces",
    'const s = ("alpha-bravo-charlie-delta,").repeat(n / 26); const ps = s.split(","); let k = 0; for (const p of ps) k += p.length + p.charCodeAt(0) + (p.endsWith("delta") ? 1 : 0); return k + ps.length;',
  ],
];

function program(): string {
  const lines: string[] = [];
  lines.push("class Lexer { src: string; constructor(s: string) { this.src = s; } next(): string { const m = /^\\s*(\\w+|.)/.exec(this.src); if (m === null) return \"\"; this.src = this.src.slice(m[0].length); return m[1]!; } }");
  lines.push("function readEvery(p: string): number { let k = 0; for (let i = 0; i < p.length; i += 97) k += p.charCodeAt(i); return k; }");
  lines.push('function grow(n: number): number { let p = ""; for (let i = 0; i < n; i += 4) p += "wxyz"; let k = 0; for (let i = 0; i < p.length; i += 101) k += p.charCodeAt(i); return k + p.slice(3).length; }');
  lines.push("function step(s: string): string { const m = /^(\\s+|\\w+|.)/.exec(s); return s.slice(m === null ? 1 : m[0].length); }");
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

test("S3 front-consuming string loops (slice(1), regex tokenizers, field/parameter tokenizers, substring scans, trimStart, split pieces) scale linearly on wasm, and agree with Node", async () => {
  const entry = join(scratch, "slices.ts");
  await writeFile(entry, program());
  const res = await compile(entry, { outPath: join(scratch, "slices.wasm"), outDir: scratch, backend: "wasm" });
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
