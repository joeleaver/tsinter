/* GH #117 / #119: evaluation order against Node.
 *
 * #117 — every argument of a console method (and of util.format) is
 * evaluated BEFORE any is formatted, so a later argument that mutates an
 * earlier one (`console.log(a, a.reverse())`) is seen by both.
 * #119 — for-of over an array or tuple reads each element LIVE by index
 * and re-reads the length every step (ArrayIterator), Map/Set iteration
 * sees entries added and skips entries deleted during the loop.
 *
 * Neighbouring forms swept for the same order bug: template literals,
 * string concatenation (`a + String(a.reverse())` converts after both
 * operands evaluate), String.raw, array/object literals, builtin call
 * arguments (Math.max/min, concat, indexOf), JSON.stringify, user calls;
 * and for the same live-iteration bug: the dyn (`unknown[]`) for-of, a
 * tuple's map/slice, the callback HOFs (forEach/map/filter/some/every/
 * reduce/reduceRight/flatMap skip the indices their callback removed),
 * typed arrays, strings, Map/Set (and their forEach). Array.of and
 * JSON.stringify's replacer refuse by name.
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
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-eval-order-"));
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
  /* ── #117: console arguments evaluate first, format second ─────────── */
  { id: "c1-reverse", src: `const a = [1, 2, 3];\nconsole.log(a, a.reverse());\nconsole.log(a.reverse(), a);` },
  { id: "c2-push", src: `const a = [1];\nconsole.log(a, a.push(2));\nconsole.log(a, (a.push(3), a));\nconsole.log(a.length, a.push(4), a.length, a);` },
  { id: "c3-methods", src: `const a = [1];\nconsole.error(a, a.push(2));\nconsole.warn(a, a.push(3));\nconsole.info(a, a.push(4));\nconsole.debug(a, a.pop());` },
  { id: "c4-containers", src: "const m = new Map<number, number>([[1, 2]]);\nconsole.log(m, (m.set(3, 4), m.size));\nconst s = new Set<number>();\nconsole.log(s, (s.add(1), s.size), s);\nconst o = { n: 1, xs: [1] };\nfunction setN(v: number) { o.n = v; return v; }\nconsole.log(o, setN(5), o.xs.push(2));\nconst r: Record<string, number> = {};\nfunction put(k: string) { r[k] = 1; return k; }\nconsole.log(r, put(\"k\"));" },
  { id: "c5-rebind", src: `let a = [1];\nconsole.log(a, (a = [2]), a);\nlet o = { v: 1 };\nfunction swap() { o = { v: 2 }; return 0; }\nconsole.log(o, swap(), o);` },
  { id: "c6-scalars", src: "let i = 0;\nconst f = () => ++i;\nconsole.log(f(), f(), i);\nlet x = 1;\nconsole.log(x, x++, x, (x = x + 10), x);\nlet s = \"a\";\nconsole.log(s, (s = s + \"b\"), s);\nlet b = false;\nconsole.log(b, (b = true), b);" },
  { id: "c7-printing-args", src: `function g(tag: string) { console.log("in", tag); return 1; }\nconst a = [1];\nconsole.log(a, g("x"), a.push(g("y")), a);\nconsole.log(g("p"), [g("q")], { k: g("r") });` },
  { id: "c8-class", src: "class C { v = 1; w: number[] = []; }\nconst c = new C();\nfunction bump(k: C) { k.v = 2; return k.w.push(3); }\nconsole.log(c, bump(c), c.v);\nclass E extends Error {}\nconst e = new E(\"m\");\nfunction setMsg(x: Error) { x.message = \"z\"; return 0; }\nconsole.log(e.message, setMsg(e), e.message);" },
  { id: "c9-nested", src: "const o = { xs: [1], inner: { n: 0 } };\nfunction poke() { o.inner.n = 7; return o.xs.push(2); }\nconsole.log(o, poke());\nconst grid = [[0, 0], [0, 0]];\nfunction cell() { grid[1]![0] = 5; return 5; }\nconsole.log(grid, cell());" },
  { id: "c12-undef-slots", src: "const xs: string[] = [];\nconsole.log(xs[0], xs.push(\"a\"), xs[0]);\nconst ns: number[] = [];\nconsole.log(ns[0], ns.push(1), ns[0]);\nlet n = 0;\nconst nl: null = null;\nconsole.log(nl, n++, nl);\nconst arrs: number[][] = [];\nconsole.log(arrs[0], arrs.push([1]), arrs);\nconst o: { k?: number[] } = {};\nfunction setK() { o.k = [2]; return 1; }\nconsole.log(o.k, o, setK(), o.k);" },
  { id: "c13-optional-fields", src: "const o: { a?: number[]; s?: string } = {};\nfunction fill() { o.a = [1]; o.s = \"x\"; return 1; }\nconsole.log(o, fill(), o);" },
  { id: "c14-format-literal", src: "const a = [1, 2];\nconsole.log(\"%s and %s\", a, a.reverse());\nconsole.log(\"%d items:\", a.length, a.push(5), a);\nlet n = 0;\nconsole.log(\"%c|\", (n++, \"color: red\"), n);\nconsole.log(\"%j\", a, a.pop());\nconsole.log(\"x %s\", a, a.push(7));\nconsole.log(\"%i %s\", a.length, a, a.shift());" },
  { id: "c15-format-runtime", src: "const a = [1, 2, 3];\nconst fmt: string = Math.random() > 2 ? \"\" : \"%s|%s\";\nconsole.log(fmt, a, a.reverse());\nconst plain: string = Math.random() > 2 ? \"%\" : \"p\";\nconsole.log(plain, a, a.pop());" },
  { id: "c16-util-format", src: "import { format, formatWithOptions } from \"node:util\";\nconst a = [1, 2, 3];\nconsole.log(format(a, a.reverse()));\nconsole.log(format(\"%s %s\", a, a.pop()));\nconsole.log(format(\"%j\", a, a.push(9)));\nconsole.log(formatWithOptions({}, a, a.shift()));\nconst o = { n: 1 };\nfunction setN() { o.n = 2; return 2; }\nconsole.log(format(o, setN()));\nconst fmt: string = Math.random() > 2 ? \"\" : \"%s\";\nconsole.log(format(fmt, a, a.reverse()));\nlet k = 0;\nconsole.log(format(\"%c%s\", (k++, \"\"), k));" },
  { id: "c17-await", src: `async function main() {\n  const a = [1];\n  const p = Promise.resolve(5);\n  console.log(a, await p, a.push(2));\n  console.log(a, a.push(await p));\n}\nmain();` },
  { id: "c18-many", src: `const a = [0];\nconsole.log(a, a, "s", 1, true, a.push(1), "t", a.push(2));\nconsole.log("lead", 2, a, a.length, a.pop());` },
  { id: "c20-loop", src: `const log: string[][] = [];\nfor (let i = 0; i < 3; i++) {\n  const row: string[] = [];\n  log.push(row);\n  console.log(log.length, row, row.push(String(i)), log);\n}` },

  /* ── neighbouring forms: templates and concatenation ───────────────── */
  { id: "t1-template", src: "const a = [1, 2, 3];\nconsole.log(`${a} ${a.reverse()}`);\nlet n = 0;\nconsole.log(`${n} ${n++} ${n} ${(n = n + 5)}`);" },
  { id: "t2-concat", src: `const a = [1, 2, 3];\nconsole.log("x" + a + a.reverse());\nconsole.log(a + String(a.reverse()));\nconsole.log(a + "|" + a.pop());\nlet s = "p";\nconsole.log(s + (s = "q") + s);` },
  { id: "t4-string-raw", src: "const a = [1, 2, 3];\nconsole.log(String.raw`${a}-${a.reverse()}`);\nlet n = 0;\nconsole.log(String.raw`${n}:${n++}:${n}`);" },

  /* ── literals and builtin call arguments ───────────────────────────── */
  { id: "l1-array-literal", src: `const a = [1, 2, 3];\nconst r = [a, a.reverse(), a.length, a.push(4)];\nconsole.log(r);\nconst s = [...a, ...a.reverse()];\nconsole.log(s);` },
  { id: "l2-object-literal", src: `const a = [1, 2];\nlet n = 0;\nconst o = { copy: a.slice(), live: a, len: a.length, pushed: a.push(3), k: n++, k2: n };\nconsole.log(o);` },
  { id: "l3-builtins", src: "function f(tag: string, v: number) { console.log(tag); return v; }\nconsole.log(Math.max(f(\"a\", 1), f(\"b\", 3), f(\"c\", 2)));\nconsole.log(Math.min(f(\"d\", 1), f(\"e\", 0)));\nconst a = [1, 2];\nconsole.log(a.concat(a.reverse()), a.indexOf(a.pop()!));\nlet s = \"ab\";\nconsole.log(s.concat((s = \"x\")), s);" },
  { id: "l4-json", src: "const a = [1, 2];\nconsole.log(JSON.stringify(a), JSON.stringify([a, a.reverse()]));\nconst o = { a: 1, b: [2] };\nfunction setA() { o.a = 5; return 5; }\nconsole.log(JSON.stringify(o), setA(), JSON.stringify({ o, len: o.b.push(3) }));" },
  { id: "l6-user-call-args", src: "function two(x: number[], n: number, y: number[]) { return x.join() + \"/\" + n + \"/\" + y.join(); }\nconst a = [1];\nconsole.log(two(a, a.push(2), a), two(a.slice(), a.pop()!, a));" },

  /* ── #119: for-of reads live ───────────────────────────────────────── */
  { id: "f1-tuple-write", src: "const t: [number, number] = [1, 2];\nfor (const v of t) { t[1] = 9; console.log(v); }\nconst u: [string, number, boolean] = [\"a\", 1, true];\nfor (const v of u) { u[2] = false; u[1] = 5; console.log(v); }\nconst w: [number, number, number] = [1, 2, 3];\nconst fs: (() => number)[] = [];\nfor (const v of w) { w[0] = 0; w[2] = 30; fs.push(() => v); }\nconsole.log(fs.map((f) => f()));\nlet x: [number, number] = [1, 2];\nfor (const v of x) { x = [7, 8]; console.log(v); }\nouter: for (const a of t) { for (const b of t) { if (b === 9) continue outer; console.log(a, b); } }\nvar vv = 0;\nfor (var vv of t) { t[1] = 4; }\nconsole.log(vv);\nlet le = 0;\nfor (le of t) { t[1] = 5; }\nconsole.log(le);\nfor (const [k, q] of [[\"a\", 1], [\"b\", 2]] as [string, number][]) console.log(k, q);\nconst pairs: [[string, number], [string, number]] = [[\"a\", 1], [\"b\", 2]];\nfor (const [k, q] of pairs) { pairs[1] = [\"z\", 26]; console.log(k, q); }" },
  { id: "f2-tuple-call-receiver", src: `const t: [number, number] = [1, 2];\nlet calls = 0;\nfunction get(): [number, number] { calls++; return t; }\nfor (const v of get()) { t[1] = 9; console.log(v); }\nconsole.log(calls);\nconst box = { t: [3, 4] as [number, number] };\nfor (const v of box.t) { box.t[1] = 8; console.log(v); }` },
  { id: "f4-array-push", src: `const xs = [1, 2];\nfor (const x of xs) { if (xs.length < 5) xs.push(x * 10); console.log(x); }\nconsole.log(xs);` },
  { id: "f5-array-pop-shift", src: `const xs = [1, 2, 3, 4];\nfor (const x of xs) { xs.pop(); console.log(x); }\nconst ys = [1, 2, 3, 4];\nfor (const y of ys) { ys.shift(); console.log(y); }` },
  { id: "f6-array-splice", src: `const xs = [1, 2, 3, 4];\nfor (const x of xs) { if (x === 2) xs.splice(0, 1); console.log(x); }\nconst ys = [1, 2, 3];\nfor (const y of ys) { if (y === 1) ys.splice(1, 0, 9, 8); console.log(y); }` },
  { id: "f7-array-write", src: `const xs = [1, 2, 3];\nfor (const x of xs) { xs[2] = 99; xs[0] = -1; console.log(x); }\nconst ss = ["a", "b"];\nfor (const s of ss) { ss[1] = "z"; console.log(s); }` },
  { id: "f8-array-rebind", src: `let xs = [1, 2];\nfor (const x of xs) { xs = [7, 8, 9]; console.log(x); }\nconst o = { xs: [1, 2] };\nfor (const x of o.xs) { o.xs = [5, 5, 5]; console.log(x); }\nconst q = { xs: [1, 2] };\nfor (const x of q.xs) { if (q.xs.length < 3) q.xs.push(3); console.log(x); }` },
  { id: "f9-array-call-receiver", src: `const xs = [1, 2];\nlet calls = 0;\nfunction get() { calls++; return xs; }\nfor (const x of get()) { if (xs.length < 4) xs.push(x + 100); console.log(x); }\nconsole.log(calls);` },
  { id: "f10-array-break-continue", src: `const xs = [1, 2, 3, 4, 5];\nfor (const x of xs) { if (x === 2) { xs.push(6); continue; } if (x === 5) break; console.log(x); }\nconsole.log(xs.length);` },
  { id: "f11-nested", src: `const xs = [1, 2];\nfor (const a of xs) { for (const b of xs) { if (xs.length < 4) xs.push(a * 10 + b); console.log(a, b); } }` },
  { id: "f12-objects", src: `const xs = [{ n: 1 }, { n: 2 }];\nfor (const x of xs) { xs[1] = { n: 9 }; if (xs.length < 3) xs.push({ n: 3 }); console.log(x.n); }` },
  { id: "f13-array-iterators", src: `const xs = [1, 2];\nfor (const [i, v] of xs.entries()) { if (xs.length < 4) xs.push(v * 10); console.log(i, v); }\nconst ys = [1, 2];\nfor (const v of ys.values()) { if (ys.length < 3) ys.push(3); ys[0] = 0; console.log(v); }\nconst zs = [1, 2];\nfor (const k of zs.keys()) { if (zs.length < 3) zs.push(3); console.log(k); }` },
  { id: "f14-typed-arrays", src: "const u = new Uint8Array([1, 2, 3]);\nfor (const v of u) { u[2] = 9; console.log(v); }\nconst f = new Int32Array([5, 6]);\nfor (const v of f) { f[1] = -7; console.log(v); }" },
  { id: "f15-strings", src: `let s = "ab";\nfor (const c of s) { s += "x"; console.log(c); }\nconsole.log(s);\nconst o = { s: "hé😀" };\nfor (const c of o.s) { o.s = ""; console.log(c); }` },
  { id: "f16-map-add-delete", src: `const m = new Map<number, string>([[1, "a"]]);\nfor (const [k] of m) { if (k < 4) m.set(k + 1, "x"); console.log(k); }\nconst d = new Map<number, string>([[1, "a"], [2, "b"], [3, "c"]]);\nfor (const [k, v] of d) { if (k === 1) d.delete(2); console.log(k, v); }\nconst w = new Map<number, string>([[1, "a"], [2, "b"]]);\nfor (const [k, v] of w) { if (k === 1) w.set(2, "z"); console.log(k, v); }` },
  { id: "f17-map-readd-clear", src: "const m = new Map<number, number>([[1, 0], [2, 0]]);\nlet seen = 0;\nfor (const [k] of m) { seen++; if (seen < 4) { m.delete(k); m.set(k, seen); } console.log(k); }\nfor (const [k, v] of m) console.log(\"after\", k, v);\nconst c = new Map<string, number>([[\"a\", 1], [\"b\", 2]]);\nfor (const [k] of c) { c.clear(); console.log(k); }" },
  { id: "f18-map-iterators", src: `const m = new Map<number, string>([[1, "a"], [2, "b"]]);\nfor (const k of m.keys()) { if (k === 1) { m.delete(2); m.set(3, "c"); } console.log(k); }\nfor (const v of m.values()) { if (m.size < 3) m.set(4, "d"); console.log(v); }\nfor (const [k, v] of m.entries()) { if (k === 1) m.delete(3); console.log(k, v); }` },
  { id: "f19-set", src: `const s = new Set([1]);\nfor (const v of s) { if (v < 4) s.add(v + 1); console.log(v); }\nconst d = new Set([1, 2, 3]);\nfor (const v of d) { if (v === 1) d.delete(3); console.log(v); }\nconst r = new Set([1, 2]);\nlet n = 0;\nfor (const v of r) { if (++n < 4) { r.delete(v); r.add(v); } console.log(v); }\nconst c = new Set(["a", "b"]);\nfor (const v of c.values()) { c.clear(); console.log(v); }` },
  { id: "f20-foreach-neighbours", src: "const xs = [1, 2, 3];\nxs.forEach((x) => { if (xs.length < 5) xs.push(x * 10); console.log(x); });\nconsole.log(xs);" },
  { id: "f21-callbacks-shrink", src: "const a = [1, 2, 3, 4];\na.forEach((x) => { a.pop(); console.log(\"fe\", x); });\nconst b = [1, 2, 3, 4];\nconsole.log(b.filter((x) => { b.pop(); return true; }));\nconst c = [1, 2, 3, 4];\nconsole.log(c.some((x) => { c.pop(); console.log(\"some\", x); return false; }));\nconst d = [1, 2, 3, 4];\nconsole.log(d.every((x) => { d.pop(); console.log(\"every\", x); return true; }));\nconst e = [1, 2, 3, 4];\nconsole.log(e.find((x) => { e.pop(); console.log(\"find\", x); return false; }));\nconst f = [1, 2, 3, 4];\nconsole.log(f.findIndex((x) => { f.pop(); console.log(\"fi\", x); return false; }));\nconst g = [1, 2, 3, 4];\nconsole.log(g.reduce((acc, x) => { g.pop(); return acc + x; }, 0));\nconst h = [1, 2];\nconsole.log(h.map((x) => { h.push(x); return x * 2; }), h);\nconst i = [1, 2, 3];\ni.forEach((x, k) => { if (k === 0) i[2] = 9; console.log(\"fe2\", x); });\nconst j = [1, 2, 3];\nconsole.log(j.join((j.push(4), \"-\")));\nconst r = { n: 1, m: 2 };\nfunction bump() { r.n = 5; return 3; }\nconsole.log({ ...r, k: bump() }, r);\nconst s = [1, 2];\nconsole.log([...s, s.push(3)], s);" },
  { id: "f22-callbacks-more", src: "const m = new Map<number, string>([[1, \"a\"], [2, \"b\"], [3, \"c\"]]);\nm.forEach((v, k) => { if (k === 1) { m.delete(2); m.set(4, \"d\"); } console.log(\"mfe\", k, v); });\nconst s = new Set([1, 2, 3]);\ns.forEach((v) => { if (v === 1) { s.delete(2); s.add(5); } console.log(\"sfe\", v); });\nconst t: [number, number] = [1, 2];\nconsole.log(t.map((v) => { t[1] = 9; return v; }));\nconst u = new Uint8Array([1, 2, 3]);\nconsole.log(Array.from(new Set([1, 2]), (x) => x));\nconst xs = [1, 2, 3];\nconsole.log(xs.flatMap((x) => { xs.pop(); return [x, x]; }));\nconst ys = [1, 2, 3, 4];\nconsole.log(ys.reduceRight((acc, y) => { ys.shift(); return acc + y; }, 0));\nconst zs = [1, 2, 3];\nconst out: number[] = [];\nfor (const z of zs.slice()) { zs.push(z); out.push(z); }\nconsole.log(out, zs);\nconst ks = [1, 2, 3];\nfor (const [i, k] of ks.entries()) { ks.pop(); console.log(\"ent\", i, k); }\nconst it = [1, 2];\nfor (const v of it.values()) { if (it.length < 4) it.push(v + 2); console.log(\"vals\", v); }" },
  { id: "f23-dyn-forof", src: "const u: unknown = JSON.parse(\"[1,2,3]\");\nif (Array.isArray(u)) {\n  for (const v of u) { if (u.length < 5) u.push(9); console.log(\"dyn\", v); }\n  console.log(u);\n}\nconst xs: unknown[] = [1, 2];\nfor (const v of xs) { if (xs.length < 4) xs.push(\"x\"); console.log(\"unk\", v); }\nconst ys: unknown[] = [1, 2, 3];\nconsole.log(ys.filter((v) => { ys.pop(); return true; }));\nconst t: [number, number] = [1, 2];\nconsole.log(t.map((v) => { t[1] = 9; return v; }), t.map((v, i) => v + i));\nfunction mk(): [string, string] { console.log(\"mk\"); return [\"a\", \"b\"]; }\nfor (const s of mk()) console.log(s);\nconst xs2 = [1, 2, 3, 4];\nconsole.log(xs2.map((x) => { xs2.pop(); return x * 2; }).length);" },
  { id: "f24-tuple-map", src: "const t: [number, number, number] = [1, 2, 3];\nconsole.log(t.map((v) => { t[2] = 30; return v; }), t.map((v, i) => { t[0] = i; return v * 10; }), t);\nconst h: [string, string] = [\"a\", \"b\"];\nfunction setH() { h[1] = \"y\"; return 0; }\nconsole.log(h.map((v) => { h[1] = \"z\"; return v + \"!\"; }), h.slice(setH()));\nlet calls = 0;\nfunction get(): [number, number] { calls++; return [4, 5]; }\nconsole.log(get().map((v) => v + 1), calls);" },
  { id: "c21-format-c-effects", src: "let n = 0;\nconst bump = () => { n++; return \"\"; };\nconsole.log(\"%c%c\", bump(), bump(), n);\nconsole.log(\"a%cb\", bump());\nconsole.log(n);" },
  { id: "c22-contexts", src: "const a = [1];\nfunction* g() { console.log(a, yield 1, a.push(2)); console.log(a, a.pop(), yield 2); }\nconst it = g();\nit.next(); it.next(7); it.next(8);\nconst f = () => console.log(a, a.push(3));\nf();\nclass C { static { console.log(a, a.push(4)); } m = [0]; constructor() { console.log(this.m, this.m.push(1)); } }\nnew C();\nconst flag = a.length > 0;\nif (flag) console.log(a, a.pop()); else console.log(a, a.push(9));\nconst s = flag ? `${a}` + String(a.push(5)) : \"\";\nconsole.log(s, a + String(a.pop()));\nasync function k() { const b = [1]; for (let i = 0; i < 2; i++) console.log(b, await Promise.resolve(i), b.push(i)); }\nk().then(() => console.log(\"done\"));\nlabel: for (const v of [1, 2, 3] as const) { if (v === 2) continue label; console.log(v, a, a.push(v)); }" },
  { id: "l7-object-assign", src: "const cfg: Record<string, number> = { a: 1 };\nconst s1: Record<string, number> = { b: 2 };\nfunction m(): Record<string, number> { s1[\"b\"] = 5; return { c: 3 }; }\nconsole.log(Object.assign(cfg, s1, m()), cfg);\nconst o = { a: 1, b: 2 };\nfunction bump() { o.a = 9; return { c: 3 }; }\nconsole.log(Object.assign({}, o, bump()));\nconst parts = [{ x: 1 }, { y: 2 }];\nconst core = { z: 3 };\nconsole.log(Object.assign({}, ...parts, core));" },
  { id: "l8-assign-map-assert", src: "import assert from \"node:assert\";\nconst o = { a: 1, b: 2 };\nfunction bump() { o.a = 9; return { c: 3 }; }\nconsole.log(Object.assign({}, o, bump()));\nconst xs = [3, 1, 2];\nconst m = new Map([[\"k\", xs], [\"j\", (xs.pop(), xs)]]);\nconsole.log(m.get(\"k\"));\nassert.deepStrictEqual(xs, (xs.push(4), xs));\nconsole.log(\"ok\", xs);\nconst strs = [\"b\", \"a\"];\nconsole.log(strs.join(String(strs.sort())), strs);\nconsole.log(`${xs.length}${xs.push(1)}${xs.length}`);" },
  /* ── GH #122: narrowed refusals ─────────────────────────────────────── */
  // A spread before a later argument with an effect takes its spine where
  // it stands (Node iterates it there); writes INTO its elements are still
  // seen, since Object.assign copies after every argument.
  { id: "n1-assign-spread-sources", src: "const base = { a: 1 };\nconst items = [\"x\", \"y\"];\nconsole.log(Object.assign({}, base, ...items.map((k) => ({ [k]: 1 }))));\nconst parts = [{ x: 1 }, { y: 2 }];\nfunction mk(n: number) { return { n }; }\nconsole.log(Object.assign({}, ...parts, mk(1)));\nconsole.log(Object.assign({}, ...parts, (parts.push({ x: 2 }), { z: 3 })));\nconsole.log(parts.length);\nconst ps = [{ x: 1, y: 0 }, { x: 2, y: 2 }];\nfunction poke() { ps[0]!.x = 5; ps.pop(); return { z: 3 }; }\nconsole.log(Object.assign({}, ...ps, poke()), ps);\nconst qs = [{ x: 1 }];\nfunction grow() { qs.push({ x: 9 }); qs[0] = { x: 7 }; return { w: 1 }; }\nconsole.log(Object.assign({}, base, ...qs, grow(), ...qs));\nconst u: unknown = JSON.parse('[{\"d\":1},{\"e\":2}]');\nif (Array.isArray(u)) {\n  console.log(Object.assign({}, ...u, (u.push({ f: 3 }), { g: 4 })), u.length);\n  console.log(Object.assign({}, base, ...u, mk(2)));\n}\nconsole.log(Object.assign({}, ...\"ab\", mk(3)));" },
  // The tuple map's array parameter, read only: its length, or its
  // elements where nothing in the callback can write the tuple.
  { id: "n2-tuple-map-array-param", src: "const t: [number, number] = [1, 2];\nconsole.log(t.map((v, i, arr) => v + arr.length));\nconsole.log(t.map((v, i, arr) => arr[1 - i]! * 10 + v));\nconst u: [string, string, string] = [\"a\", \"b\", \"c\"];\nconsole.log(u.map((v, i, arr) => `${v}/${arr.length}/${arr[(i + 1) % arr.length]}`));\nconsole.log(u.map(function (v, i, arr) { const n = arr.length; let s = 0; for (let k = 0; k < n; k++) s += k; return String(v) + s; }));\nconst w: [number, number, number] = [5, 6, 7];\nconsole.log(w.map((v, i, arr) => { const f = () => arr.length; return f() + v; }));\nconsole.log(w.map((v, _i, arr) => arr.length > 2 ? v : -v));\nconsole.log(t.map((v, i, arr) => { t[1] = 4; return v + arr.length; }), t);" },
];

/** Rows where Node answers and this tier stops by name at run time: the
 * output up to the stop equals Node's, then the named fence. */
const FENCES: { id: string; src: string; stdout: string; stderr: RegExp }[] = [
  {
    // A map whose callback shrank its array leaves holes in the result
    // (Node prints `<2 empty items>`); the holes are stored as undefined,
    // so printing the result keeps S119's hole fence.
    id: "map-shrunk-hole-print",
    src: "const xs = [1, 2, 3, 4];\nconst r = xs.map((x) => { xs.pop(); return x * 2; });\nconsole.log(r.length, r[0], r[1], r[2]);\nconsole.log(r);",
    stdout: "4 2 4 undefined\n",
    stderr: /^tsinter: unsupported: printing \(util\.inspect\) over an array that may hold holes .*SEMANTICS\.md S119\) \[SC1090( at [^\]]*)?\]\n/,
  },
];

/** Forms that stay compile refusals, each by name. */
const REFUSALS: { id: string; src: string; message: RegExp }[] = [
  { id: "json-replacer", src: "const o = { a: 1 };\nconsole.log(JSON.stringify(o, (k, v) => v));", message: /'JSON\.stringify with replacer\/space parameters'/ },
  // GH #122: the tuple map's array parameter is a fresh array of the
  // positions — refused wherever the callback could tell it from the
  // tuple (Node: [ 10, 18 ], [ 51, 52 ], [ 50, 2 ] [ 3, 2 ]).
  { id: "tuple-map-array-param-write-by-name", src: "const t: [number, number] = [1, 2];\nconsole.log(t.map((v, i, arr) => { t[1] = 9; return arr[1]! + v; }));", message: /\[number, number\]\.map with a callback that takes the array/ },
  { id: "tuple-map-array-param-call", src: "const t: [number, number] = [1, 2];\nfunction poke(): number { t[0] = 50; return 0; }\nconsole.log(t.map((v, i, arr) => arr[poke()]! + v));", message: /\[number, number\]\.map with a callback that takes the array/ },
  { id: "tuple-map-array-param-write-through", src: "const t: [number, number] = [1, 2];\nconsole.log(t.map((v, i, arr) => { arr[0] = 3; return v; }), t);", message: /\[number, number\]\.map with a callback that takes the array/ },
  { id: "tuple-map-array-param-escape", src: "const t: [number, number] = [1, 2];\nconst keep: number[][] = [];\nconsole.log(t.map((v, i, arr) => { keep.push(arr); return v; }));", message: /\[number, number\]\.map with a callback that takes the array/ },
  // Object elements can reach the tuple: a field holding it, a getter, a
  // setter (review of #122).
  { id: "tuple-map-array-param-write-through-elem", src: "class Box { self: [Box, Box] | null = null; constructor(public n: number) {} }\nconst b0 = new Box(10), b1 = new Box(20);\nconst t: [Box, Box] = [b0, b1];\nb0.self = t;\nconsole.log(t.map((v, i, arr) => { if (i === 0) { arr[0]!.self![1] = arr[0]!; return arr[1]!.n; } return -1; }), t[1].n);", message: /\[Box, Box\]\.map with a callback that takes the array/ },
  { id: "tuple-map-array-param-getter-elem", src: "class C { constructor(public n: number) {} get g(): number { t[1] = t[0]; return 1; } }\nconst t: [C, C] = [new C(10), new C(20)];\nconsole.log(t.map((v, i, arr) => i === 0 ? arr[0]!.g + arr[1]!.n : -1), t[1].n);", message: /\[C, C\]\.map with a callback that takes the array/ },
  { id: "tuple-map-array-param-setter-elem", src: "class C { constructor(public n: number) {} set s(x: number) { t[1] = t[0]; } }\nconst t: [C, C] = [new C(10), new C(20)];\nconsole.log(t.map((v, i, arr) => { if (i === 0) arr[0]!.s = 1; return arr[1]!.n; }), t[1].n);", message: /\[C, C\]\.map with a callback that takes the array/ },
  // A spread with no spine snapshot (a Set) before a later argument that
  // may write it (Node: { '0': 'c', '1': 'b', n: 1 } — the added "zz" is
  // not seen).
  { id: "assign-set-spread-then-write", src: "const s = new Set([\"ab\", \"c\"]);\nfunction mk(n: number) { s.add(\"zz\"); return { n }; }\nconsole.log(Object.assign({}, ...s, mk(1)));", message: /'Object\.assign with spread sources and a later argument that may write'/ },
];

describe("GH #117/#119: runtime stops by name", () => {
  test.for(FENCES.map((r) => [r.id, r] as const))("%s (wasm)", async ([id, row]) => {
    const file = join(scratch, `fence-${id}.ts`);
    writeFileSync(file, row.src + "\n");
    expect(nodeRun(file).exitCode).toBe(0);
    const res = await compile(file, { outPath: join(scratch, `fence-${id}.wasm`), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = await runWasmToTrap(res.binaryPath);
    expect(String(r.stdout)).toBe(row.stdout);
    expect(String(r.stderr)).toMatch(row.stderr);
  });
  test.for(FENCES.map((r) => [r.id, r] as const))("%s (wasm-native)", async ([id, row]) => {
    const file = join(scratch, `fence-${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    const got = await nativeRun(`fence-${id}`, file);
    expect(got.stdout).toBe(row.stdout);
    expect(got.exitCode).not.toBe(0);
    expect(got.stderr).toMatch(row.stderr);
  }, 600_000);
});

describe("GH #117/#119: forms that stay refused by name", () => {
  test.for(REFUSALS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `refuse-${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const res = await compile(file, { outPath: join(scratch, `refuse-${id}.wasm`), outDir: scratch, backend: "wasm" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message).join("\n")).toMatch(row.message);
  });
});

describe("GH #117/#119: evaluation order (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, row.src + "\n");
    const node = nodeRun(file);
    expect(node.exitCode).toBe(0);
    expect(await wasmRun(id, file)).toEqual(node);
  });
});

describe("GH #117/#119: evaluation order (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.ts`);
    writeFileSync(file, row.src + "\n");
    const node = nodeRun(file);
    expect(node.exitCode).toBe(0);
    expect(await nativeRun(id, file)).toEqual(node);
  }, 600_000);
});
