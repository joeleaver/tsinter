/* Board #317: JSON.parse and JSON.stringify — and the builders under them
 * — must scale LINEARLY in the document on the wasm tier. The bugs this
 * pins:
 *   - `%w.json.string` sized its scratch buffer at the WHOLE REMAINING
 *     input for every string token (then copied out the few units used),
 *     so parsing was O(tokens × document): a 1 MB string-heavy document
 *     took ~10 s, the b4 benchmark requested 335 GB of scratch;
 *   - `%w.json.putDyn`'s reentrancy bracket around a `toJSON` call
 *     snapshotted the output so far (jbFinish) and replayed it (jbPuts)
 *     — a copy of everything written per toJSON call (and per object
 *     whenever island accessors are live): 256 KB of toJSON objects took
 *     ~14 s;
 *   - `%w.bytes.join` (Uint8Array.prototype.join) accumulated with one
 *     %w.concat per element: 64 Ki elements took ~27 s.
 *
 * The probe is wasm-string-scaling.test.ts's: a SCALING RATIO, not an
 * absolute time — each operation over an input of N and of 4N, best of
 * several runs, timed inside the program against the host's real clock.
 * Linear work answers ≈ 4×; the quadratic paths answered 16× and far
 * more. Below a noise floor (the 4N run under 3 ms) a ratio is not
 * checked; a run of N slower than SLOW_N_MS is reported as the quadratic
 * path outright. Every result is also compared with Node running the same
 * program (timings on their own lines, left out of the comparison). */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-json-scaling-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const RUNS = 5;
const RATIO_BOUND = 10;
const NOISE_FLOOR_MS = 3;
const SLOW_N_MS = 250;

/** One operation: `mk(n)` builds its input (outside the timing), `op(x)`
 * is timed and answers a number Node must agree with. */
interface Op {
  name: string;
  /** The input size N (the 4N run uses 4 × this). */
  n: number;
  type: string;
  mk: string;
  op: string;
}

const STATIC_OPS: Op[] = [
  {
    name: "parse strings",
    n: 128 * 1024,
    type: "string",
    mk: "{ const a: string[] = []; let len = 0; for (let i = 0; len < n; i++) { const s = 'name-' + i + '-abcdefgh'; a.push(s); len += s.length + 3; } return JSON.stringify(a); }",
    op: "{ const v = JSON.parse(x) as string[]; return v.length + v[v.length - 1]!.length; }",
  },
  {
    name: "parse escaped strings",
    n: 128 * 1024,
    type: "string",
    mk: "{ const a: string[] = []; let len = 0; for (let i = 0; len < n; i++) { const s = 'q\"\\\\' + i + '\\n\\u00e9\\u{1F600}'; a.push(s); len += s.length + 8; } return JSON.stringify(a); }",
    op: "{ const v = JSON.parse(x) as string[]; let t = 0; for (const s of v) t += s.length; return t; }",
  },
  {
    name: "parse nested",
    n: 128 * 1024,
    type: "string",
    mk: "{ const a: { id: number; name: string; tags: string[]; c: { x: number; ok: boolean } }[] = []; let len = 0; for (let i = 0; len < n; i++) { a.push({ id: i, name: 'n' + i, tags: ['t' + (i % 7), 'u'], c: { x: i * 0.5, ok: i % 2 === 0 } }); len += 70; } return JSON.stringify(a); }",
    op: "{ const v = JSON.parse(x) as { id: number; name: string; tags: string[] }[]; let t = 0; for (const r of v) t += r.id + r.name.length + r.tags.length; return t; }",
  },
  {
    name: "stringify parsed (dyn walk)",
    n: 128 * 1024,
    type: "unknown",
    mk: "{ const a: { id: number; name: string; tags: string[] }[] = []; let len = 0; for (let i = 0; len < n; i++) { a.push({ id: i, name: 'n\"' + i, tags: ['t' + (i % 7)] }); len += 40; } return JSON.parse(JSON.stringify(a)) as unknown; }",
    op: "JSON.stringify(x).length",
  },
  {
    name: "Uint8Array join",
    n: 32 * 1024,
    type: "Uint8Array",
    mk: "{ const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 7) & 255; return a; }",
    op: "x.join(',').length",
  },
];

const DYNAMIC_OPS: Op[] = [
  {
    name: "stringify toJSON objects",
    n: 64 * 1024,
    type: "any",
    mk: "{ const a: any[] = []; let len = 0; for (let i = 0; len < n; i++) { const k = 'v' + i; a.push({ k, toJSON: () => ({ k, n: 1 }) }); len += 20; } return a; }",
    op: "JSON.stringify(x).length",
  },
];

function program(ops: Op[], dynamic: boolean): string {
  const lines: string[] = [];
  if (dynamic) lines.push("// @dynamic");
  lines.push("function best<T>(f: (x: T) => number, x: T): number {");
  lines.push("  let t = Infinity;");
  lines.push(`  for (let r = 0; r < ${RUNS}; r++) {`);
  lines.push("    const t0 = performance.now();");
  lines.push("    f(x);");
  lines.push("    const dt = performance.now() - t0;");
  lines.push("    if (dt < t) t = dt;");
  lines.push(`    if (dt > ${SLOW_N_MS}) break;`);
  lines.push("  }");
  lines.push("  return t;");
  lines.push("}");
  ops.forEach((o, i) => {
    lines.push(`function mk${i}(n: number): ${o.type} ${o.mk}`);
    lines.push(`function op${i}(x: ${o.type}): number ${o.op.startsWith("{") ? o.op : `{ return ${o.op}; }`}`);
    lines.push("{");
    lines.push(`  const small = mk${i}(${o.n});`);
    lines.push(`  const big = mk${i}(${4 * o.n});`);
    lines.push(`  const tn = best(op${i}, small);`);
    lines.push(`  const slow = tn > ${SLOW_N_MS};`);
    lines.push(`  const t4n = slow ? -1 : best(op${i}, big);`);
    lines.push(`  console.log('T ${i} ' + tn + ' ' + t4n);`);
    lines.push(`  console.log('R ${i} ' + op${i}(small) + ' ' + (slow ? 'skipped' : op${i}(big)));`);
    lines.push("}");
  });
  return lines.join("\n") + "\n";
}

async function probe(label: string, ops: Op[], dynamic: boolean): Promise<void> {
  const entry = join(scratch, `${label}.ts`);
  await writeFile(entry, program(ops, dynamic));
  const res = await compile(entry, { outPath: join(scratch, `${label}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath, { imports: { now: () => performance.now() } });
  expect(run.stderr).toBe("");
  const out = run.stdout.split("\n");
  const node = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], {
    encoding: "utf8",
  }).split("\n");

  const bad: string[] = [];
  const timings = out.filter((l) => l.startsWith("T "));
  expect(timings.length).toBe(ops.length);
  for (const line of timings) {
    const [, i, tn, t4n] = line.split(" ");
    const o = ops[Number(i)]!;
    const small = Number(tn);
    const big = Number(t4n);
    if (big < 0) {
      bad.push(`${o.name}: ${small.toFixed(0)} ms at N=${o.n} — the quadratic path`);
      continue;
    }
    if (big < NOISE_FLOOR_MS) continue;
    const ratio = big / Math.max(small, 0.05);
    if (ratio > RATIO_BOUND) bad.push(`${o.name}: ×${ratio.toFixed(1)} for ×4 input (${small.toFixed(2)} → ${big.toFixed(2)} ms)`);
  }
  expect(bad).toEqual([]);
  expect(out.filter((l) => l.startsWith("R "))).toEqual(node.filter((l) => l.startsWith("R ")));
}

/* The toJSON / getter bracket's buffer SWAP (board #317) also fixed a
 * divergence the old snapshot-and-replay had: a nested stringify that
 * wrote part of its output and then threw, caught inside the toJSON or
 * getter, left that partial text in the shared buffer, and the outer
 * result came back with it glued on the front. Node gives each
 * JSON.stringify call its own output. (The review's repros, cut down.) */
const NESTED_THROW = `// @dynamic
function S(v: any): any { return JSON.stringify(v); }
function t(label: string, f: () => any): void {
  try { const r = f(); console.log(label + ' => ' + (typeof r === 'string' ? r : String(r))); }
  catch (e: any) { console.log(label + ' threw ' + e.name + ': ' + e.message); }
}
const pad: any = 'x'.repeat(40);
t('toJSON nested throws caught', () => S({ a: pad, b: { toJSON: () => { try { S({ q: pad, z: { toJSON: () => { throw new TypeError('inner'); } } }); } catch (e: any) { return 'caught ' + e.message; } return 'no'; } }, c: 3 }));
const cyc: any = { name: 'c' }; cyc.self = cyc;
t('cycle in nested caught', () => S({ a: pad, b: { toJSON: () => { try { return S([pad, cyc]); } catch (e: any) { return e.message.split('\\n')[0]; } } }, c: [cyc.name] }));
t('getter nested throws caught', () => { const o: any = { a: 1, get g() { try { return S({ q: pad, w: { toJSON: () => { throw new Error('deep'); } } }); } catch (e: any) { return 'caught ' + e.message; } } }; return S({ x: pad, o, y: 2 }); });
t('loop', () => { let r = ''; for (let i = 0; i < 3; i++) { try { r += S({ i, p: pad, a: { toJSON: () => { if (i === 1) throw new Error('e' + i); return S({ i }); } } }); } catch (e: any) { r += '!' + e.message; } } return r; });
t('after all', () => S({ ok: [1, 'x', null, true] }));
`;

test("#317 a nested stringify that throws mid-write and is caught leaves nothing in the outer result (wasm = Node)", async () => {
  const entry = join(scratch, "nested-throw.ts");
  await writeFile(entry, NESTED_THROW);
  const res = await compile(entry, { outPath: join(scratch, "nested-throw.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  const node = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe(node);
}, 300_000);

test("#317 JSON.parse / JSON.stringify / Uint8Array join scale linearly on wasm, and agree with Node", async () => {
  await probe("json-static", STATIC_OPS, false);
}, 300_000);

test("#317 a toJSON-bearing island array stringifies linearly on wasm, and agrees with Node", async () => {
  await probe("json-dynamic", DYNAMIC_OPS, true);
}, 300_000);
