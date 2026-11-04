/* GH #121: builtin methods that answer their receiver.
 *
 * `Map.prototype.set` and `Set.prototype.add` answer the Map/Set itself, so
 * `m.set(3, 4).size`, chains (`m.set(a, 1).set(b, 2)`, `s.add(x).add(y)`)
 * and the call as a value (an initializer, an argument, a return, an arrow
 * body) all see the receiver. The array mutators that answer their
 * receiver (sort, reverse, fill, and copyWithin, new here) are swept in the
 * same positions, including a typed array's sort.
 *
 * Every row runs under Node (spawned at test time) and must match it
 * byte-for-byte on the wasm and wasm-native lanes. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-receiver-results-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function nodeRun(file: string): Out {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", file], { encoding: "utf8", input: "" });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? -1 };
}

async function wasmRun(id: string, file: string): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
}

async function nativeRun(id: string, file: string): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, exitCode: err.code };
  }
}

const ROWS: { id: string; src: string }[] = [
  { id: "r1-issue", src: "const m = new Map<number, number>();\nconsole.log(m.set(3, 4).size);\nm.set(1, 1).set(2, 2);\nconsole.log(m);\nconst s = new Set<string>();\ns.add(\"x\").add(\"y\");\nconsole.log(s.add(\"z\").size, s);\nconst m2 = m.set(9, 9);\nconsole.log(m2 === m, m2.get(9));\nconst xs = [3, 1, 2];\nconsole.log(xs.sort().reverse().length, xs);\nconst ys = xs.fill(0).map((v) => v + 1);\nconsole.log(ys, xs.reverse() === xs, xs.copyWithin(0, 1).length);\nconst zs = xs.sort((a, b) => b - a);\nzs.push(7);\nconsole.log(xs, zs === xs);\nconsole.log(s.add(\"q\").has(\"q\"), m.set(5, 5).get(5));\nfunction f(): Map<number, number> { return m.set(6, 6); }\nconsole.log(f().size);" },
  { id: "r2-map-set-values", src: "const m = new Map<string, number>();\nconst s = new Set<number>();\n[1, 2, 3].forEach((x) => s.add(x));\n[1, 2].forEach((x) => s.add(x * 10));\n[\"a\", \"b\"].forEach((k, i) => m.set(k, i));\nconst r = (m.set(\"z\", 26), m.set(\"y\", 25).set(\"x\", 24));\nconsole.log(r === m, [...m.keys()]);\nlet mm = new Map<number, string>();\nconst got = mm.set(1, \"a\").set(2, \"b\");\nmm = new Map();\nconsole.log(got.size, mm.size);\nlet k = 0;\nconst n2 = new Map<number, number>();\nconst res = n2.set(k++, k++).set(k++, k++);\nconsole.log(res, k);\nfunction getM(): Map<number, number> { console.log(\"getM\"); return n2; }\nconsole.log(getM().set(9, 9).size);\nconsole.log(new Set<string>().add(\"p\").add(\"q\"));\nconsole.log(new Map<string, number>().set(\"a\", 1));\nfor (let i = 0; i < 3; s.add(i), i++) {}\nconsole.log(s);\nconst ss = s.add(100);\nss.delete(1);\nconsole.log(s.has(1));" },
  { id: "r3-receiver-rebound", src: "let m = new Map<number, number>();\nconst first = m;\nconst out = m.set(1, (m = new Map<number, number>(), 1));\nconsole.log(out === first, out.size, m.size);\nlet s = new Set<string>();\nconst s0 = s;\nconsole.log(s.add((s = new Set<string>(), \"a\")) === s0, s0.size, s.size);" },
  { id: "r4-array-mutators", src: "const xs = [3, 1, 2];\nconsole.log(xs.sort().reverse().length, xs);\nconsole.log(xs.fill(0, 1).map((v) => v + 1), xs.reverse() === xs);\nconst ss = [\"b\", \"a\", \"c\"];\nconst t = ss.sort().reverse();\nt.push(\"z\");\nconsole.log(ss, t === ss, ss.reverse().join(\"-\"));\nconst os = [{ n: 2 }, { n: 1 }];\nconsole.log(os.sort((a, b) => a.n - b.n).map((o) => o.n), os.reverse()[0]!.n);\nconst u = new Uint8Array([3, 1, 2]);\nconst u2 = u.sort();\nu2[0] = 9;\nconsole.log(u[0], u[2], u.sort() === u, u.sort().length);\nfunction g(a: number[]): number[] { return a.sort((x, y) => y - x); }\nconst ys = [1, 5, 3];\nconsole.log(g(ys) === ys, ys);" },
  { id: "r5-copy-within", src: "const cases: [number, number, number | undefined][] = [\n  [0, 3, undefined], [1, 0, undefined], [0, 1, 3], [-2, 0, undefined], [2, -3, -1], [1, 0, 2], [3, 1, 4],\n  [0, 0, 0], [10, 0, undefined], [-10, 2, undefined], [NaN, 2, NaN], [1.7, 0.2, 4.9], [-Infinity, Infinity, 5],\n];\nfor (const [t, s, e] of cases) {\n  const a = [1, 2, 3, 4, 5];\n  const r = e === undefined ? a.copyWithin(t, s) : a.copyWithin(t, s, e);\n  console.log(t, s, e, a, r === a);\n}\nconst ss = [\"a\", \"b\", \"c\", \"d\"];\nconsole.log(ss.copyWithin(1, 0).join(\"\"), ss.copyWithin(0, 2).length);\nconst os = [{ n: 1 }, { n: 2 }, { n: 3 }];\nos.copyWithin(0, 1);\nconsole.log(os, os[1] === os[2], os[0] === os[1]);\nconsole.log([1, 2, 3].copyWithin(1, 0).reverse());\nconst sp = [9, 8, 7, 6];\nconsole.log(sp.copyWithin(2, 0).fill(0, 3).sort());\nconst big = Array.from({ length: 8 }, (_, i) => i);\nconsole.log(big.copyWithin(2, 0, 6), big.copyWithin(0, 3, 7), big.copyWithin(-3, -6, -1));" },
];

describe("GH #121: receiver results (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const node = nodeRun(file);
    expect(node.exitCode).toBe(0);
    expect(await wasmRun(id, file)).toEqual(node);
  });
});

describe("GH #121: receiver results (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    const node = nodeRun(file);
    expect(node.exitCode).toBe(0);
    expect(await nativeRun(id, file)).toEqual(node);
  }, 600_000);
});
