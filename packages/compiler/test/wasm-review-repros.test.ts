/* The GH #86 review's repros, kept for good: the programs that showed a
 * working program dying at a fence where Node throws, a catchable
 * tsinter-only error silently steering a program, and undefined-slot
 * misbehaviour. An `exact` row must equal Node (spawned at test time) on
 * the wasm and wasm-native lanes. A `fence` row is one where Node answers and
 * this tier cannot (SEMANTICS.md S122, S119, S015, S016): it pins what
 * printed before the fence, the fence line, exit 1 — and that no program
 * error path ran. */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-review-repros-"));
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

async function wasmRun(id: string, file: string, trap: boolean, dynamic = false): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await (trap ? runWasmToTrap : runWasm)(res.binaryPath);
  return { stdout: String(r.stdout), stderr: String(r.stderr).split(file).join("<ROW>"), exitCode: trap ? 1 : r.exitCode };
}

async function nativeRun(id: string, file: string, dynamic = false): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", dynamic });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  try {
    const p = run(res.binaryPath, [], { encoding: "utf8" });
    p.child.stdin?.end();
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr.split(file).join("<ROW>"), exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr.split(file).join("<ROW>"), exitCode: err.code };
  }
}

const SC1100 = (t: string): string => `tsinter: unsupported: ${t} [SC1100]\n`;
const BOTH_KEYS =
  "tsinter: unsupported: telling a missing record key from a field holding an explicit undefined, in a program that has both, is not supported yet (SEMANTICS.md S119 (i)) [SC1090]\n";
const PLUS_NAN = (line: number): RegExp => new RegExp(`^tsinter: unsupported: .*\\[SC1090 at <ROW>:${line}\\]\\n$`);

interface Row {
  id: string;
  ext: "ts" | "mjs" | "cjs";
  src: string;
  /** built with --dynamic */
  dynamic?: true;
  /** reaches the file system, which this package's wasm host does not
   * serve: the wasm-native lane runs it (the same module). stdout only:
   * Node's DEP0187 warning carries its pid (S119 (j)). */
  fsHost?: true;
  /** absent: the row equals Node */
  fence?: { stdout: string; stderr: string | RegExp };
}

const ROWS: Row[] = [
  {
    id: "sc1-clone-function",
    ext: "ts",
    src: `function cloneOr<T>(v: T, fallback: T): T {
  try { return structuredClone(v); } catch { return fallback; }
}
console.log(cloneOr<unknown>(() => 1, "uncloneable"));
console.log(cloneOr<unknown>({ a: 1 }, "x"));`,
  },
  {
    // Node quotes the source text exactly: multi-line bodies, async, and
    // a declaration referenced by name. (A TypeScript source has no
    // Node-defined text — S122.)
    id: "sc1b-clone-function-text",
    ext: "mjs",
    src: `function report(v) {
  try { structuredClone(v); console.log("cloned"); } catch (e) { console.log(e.name, e.code, e.message); }
}
function named(a, b) {
  // a comment stays
  return a + b;
}
report(named);
report(async (x) => { return x; });
report(function () { return 1; });
report(5);`,
  },
  {
    id: "sc2-x509-garbage",
    ext: "ts",
    src: `import * as crypto from "node:crypto";
function isCert(pem: string): boolean {
  try { new crypto.X509Certificate(pem); return true; } catch { return false; }
}
console.log(isCert("-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n"));
console.log("done");`,
  },
  {
    // the reasons the outer header decides, against Node's own text and code
    id: "sc2b-x509-reasons",
    ext: "ts",
    src: `import * as crypto from "node:crypto";
function pem(b: number[]): string {
  return "-----BEGIN CERTIFICATE-----\\n" + Buffer.from(b).toString("base64") + "\\n-----END CERTIFICATE-----\\n";
}
const cases: number[][] = [[0x31, 3, 1, 2, 3], [2, 1, 5], [0x30], [0x30, 0x82, 1], [0x30, 0x82, 0x10, 0, 1, 2, 3], [0x30, 3, 1], [0x30, 0], [255, 255, 255], [0], [0x68, 0x65, 0x6c, 0x6c, 0x6f]];
for (const b of cases) {
  try { new crypto.X509Certificate(pem(b)); console.log("ok"); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); }
}`,
  },
  {
    // deeper than the outer header: OpenSSL's reason needs the template
    id: "sc2c-x509-deep",
    ext: "ts",
    src: `import * as crypto from "node:crypto";
const body = Buffer.from([0x30, 3, 2, 1, 5]).toString("base64");
try { new crypto.X509Certificate("-----BEGIN CERTIFICATE-----\\n" + body + "\\n-----END CERTIFICATE-----\\n"); } catch { console.log("caught"); }`,
    fence: { stdout: "", stderr: /^tsinter: unsupported: new crypto\.X509Certificate of a PEM block whose body is not a certificate's DER is not supported yet \(SEMANTICS\.md S093\) \[SC1090\]\n$/ },
  },
  // ── the re-review's A1: `!` and `as` let undefined and null through, as
  // Node does; the next step that needs a value throws Node's TypeError.
  {
    id: "a1-map-get-bang-member",
    ext: "ts",
    src: `const m = new Map<string, string>([["a", "x"]]);
console.log(m.get("a")!.toUpperCase());
function up(k: string): string {
  try { return m.get(k)!.toUpperCase(); } catch (e) { return (e as Error).name + ": " + (e as Error).message; }
}
console.log(up("a"), up("q"));
console.log(m.get("q")!, typeof m.get("q")!, m.get("a")!);`,
  },
  {
    id: "a1-find-bang-field",
    ext: "ts",
    src: `const xs = [{ a: 1 }, { a: 2 }];
try { console.log(xs.find((x) => x.a === 2)!.a); console.log(xs.find((x) => x.a === 9)!.a); } catch (e) { console.log((e as Error).message); }
class C { c?: { d: number }; }
const c = new C();
try { console.log(c.c!.d); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "a1-match-bang-null",
    ext: "ts",
    src: `const s = "abc";
try { console.log(s.match(/b/)![0]); console.log(s.match(/x/)![0]); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const m = /x/.exec(s);
try { console.log(m![1]); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "a1-env-cast",
    ext: "ts",
    src: `const a = process.env.TSINTER_NOPE_X as string;
const b = process.env.TSINTER_NOPE_X!;
console.log(a, b, typeof a, a === undefined, b ?? "dflt");
try { console.log((process.env.TSINTER_NOPE_X as string).length); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "a1-cast-arith",
    ext: "ts",
    src: `const m = new Map<string, number>([["a", 1]]);
console.log((m.get("a") as number) + 1, (m.get("q") as number) + 1);
const xs: number[] = [];
const y = xs.shift() as number;
console.log(y, y === undefined, y + 1);
let ms: string[] | undefined;
try { console.log(ms!.length); } catch (e) { console.log((e as Error).message); }
ms = ["a"];
console.log(ms!.length);`,
  },
  {
    id: "a1-union-sub-narrow",
    ext: "ts",
    src: `type U = string | number | undefined;
const vals: U[] = ["a", 1, undefined];
for (const v of vals) { const t = v as string | number; console.log(t, typeof t); }`,
  },
  // ── A2: a dynamic undefined enters a typed slot, as in Node.
  {
    id: "a2-json-missing-field",
    ext: "ts",
    src: `interface U { id: number; name: string; ok: boolean; tags: string[]; }
const u = JSON.parse('{"id":1}') as U;
console.log(u.id, u.name, u.ok, u.tags, typeof u.name, u.name === undefined);
console.log(JSON.stringify(u));
try { console.log(u.tags.length); } catch (e) { console.log((e as Error).message); }`,
  },
  {
    id: "a2-any-into-typed",
    ext: "mjs",
    src: `function show(n) { return typeof n; }
const cfg = JSON.parse('{"a":1}');
console.log(show(cfg.b), cfg.name);`,
  },
  {
    id: "a2-typed-name",
    ext: "ts",
    src: `const cfg = JSON.parse('{"a":1}');
const name: string = cfg.name;
console.log(name, typeof name);
function show(n: number): string { return String(n) + " " + typeof n; }
const o: { b: number } = JSON.parse("{}");
console.log(show(o.b));
const us = JSON.parse("[1]") as number[];
console.log(us[3], (JSON.parse('[null]') as (number | null)[])[0]);`,
  },
  {
    id: "a2-json-undefined-array-elem",
    ext: "ts",
    src: `const b = JSON.parse('{"k":{}}') as { k: { z: string } };
console.log(b.k.z, Object.keys(b.k).length, Object.entries(b.k).length, b);
for (const k in b.k) console.log("key", k);`,
  },
  {
    // S119 (i): only missing keys — every observer reads them absent
    id: "a2-i-missing-only",
    ext: "ts",
    src: `interface U { id: number; note: string }
const u = JSON.parse('{"id":1}') as U;
console.log("note" in u, "id" in u, Object.hasOwn(u, "note"), Object.hasOwn(u, "id"));
console.log(Object.keys(u), Object.values(u), Object.entries(u));
for (const k in u) console.log(k);
console.log(u, JSON.stringify(u));
const v = { ...u };
console.log(Object.keys(v), "note" in v, v);`,
  },
  {
    // only explicit undefineds — every observer reads them present
    id: "a2-i-explicit-only",
    ext: "ts",
    src: `interface U { id: number; note: string }
const xs: string[] = [];
const w: U = { id: 2, note: xs[3] };
console.log("note" in w, Object.hasOwn(w, "note"), Object.keys(w), Object.values(w), Object.entries(w));
console.log(w, JSON.stringify(w));
const q: U = { id: 3, note: "n" };
q.note = xs[1];
console.log(Object.keys(q), q);
const dyn = JSON.parse('{"id":1,"note":"x"}') as U;
console.log(Object.keys(dyn), dyn);
const v = { ...w };
console.log(Object.keys(v), "note" in v);`,
  },
  {
    // both in one program: the slot cannot tell them apart, so it is loud
    id: "a2-i-both-fence",
    ext: "ts",
    src: `interface U { id: number; note: string }
const xs: string[] = [];
const u = JSON.parse('{"id":1}') as U;
const w: U = { id: 2, note: xs[3] };
console.log(u.note, w.note);
try { console.log(Object.keys(w)); } catch { console.log("caught"); }`,
    fence: {
      stdout: "undefined undefined\n",
      stderr: "tsinter: unsupported: telling a missing record key from a field holding an explicit undefined, in a program that has both, is not supported yet (SEMANTICS.md S119 (i)) [SC1090]\n",
    },
  },
  {
    // S119 (g): a plain-typed undefined crossing into structuredClone
    id: "a2-clone-plain-undefined",
    ext: "ts",
    src: `const xs: number[] = [];
const c = structuredClone({ a: xs[3], b: 1 });
console.log(c.a, c.b, JSON.stringify(c));
const ss: string[] = [];
console.log(structuredClone({ s: ss[0] }).s);`,
  },
  {
    // still fatal: a wrong-TYPE value, and null where a plain slot cannot
    // hold it (the owner's call, re-review item 4)
    id: "a2-wrong-type-stays",
    ext: "ts",
    src: `interface U { id: number }
try { const u = JSON.parse('{"id":"x"}') as U; console.log("ok", u.id); } catch { console.log("caught"); }`,
    fence: { stdout: "", stderr: SC1100("expected number at $.id, got string") },
  },
  {
    // S119 (e), retired: a re-tag of a union holding undefined used to trap bare
    id: "e-retag-undefined",
    ext: "ts",
    src: `function* g(xs: (number | string)[]): Generator<number | string> { yield xs[5]; }
for (const v of g([])) console.log(v);
type A = number | string;
type B = number | string | boolean;
const ys: A[] = [];
const b: B = ys[3];
console.log(b, typeof b);`,
  },
  {
    id: "r4-member-reads",
    ext: "ts",
    src: "interface U { id: number; name: string; tags: string[]; nest: { k: string } }\nclass K { v = 1; s = \"x\"; m() { return this.v; } get g() { return this.v; } set g(x: number) { this.v = x; } }\nclass D extends K { n = 2; m() { return this.n; } }\nconst us: U[] = [{ id: 1, name: \"a\", tags: [\"t\"], nest: { k: \"z\" } }];\nfunction get(id: number): U { return us.find((u) => u.id === id)!; }\nfunction t(label: string, f: () => unknown): void {\n  try { console.log(label, f()); } catch (e) { console.log(label, \"CAUGHT\", (e as Error).name, (e as Error).message); }\n}\nconst m = new Map<string, U>();\nconst es: { meta?: { k: string } }[] = [{}];\nconst ks: K[] = [];\nconst ds: D[] = [];\nconst aa: number[][] = [];\nconst ss: string[] = [];\nconst i = 7;\nt(\"a\", () => get(9).name);\nt(\"b\", () => { const v = m.get(\"zz\")!; return v.name; });\nt(\"c\", () => { const q = es[0]!.meta!; return q.k; });\nt(\"d\", () => get(9).tags[0]);\nt(\"e\", () => get(9).nest.k);\nt(\"f\", () => us[3].nest.k);\nt(\"g\", () => ks[0].v);\nt(\"h\", () => ks[0].m());\nt(\"i\", () => ks[0].g);\nt(\"j\", () => ds[0].m());\nt(\"k\", () => ds[0].n);\nt(\"l\", () => aa[0][1]);\nt(\"m\", () => aa[0][i]);\nt(\"n\", () => aa[0][1.5]);\nt(\"o\", () => ss[0][i]);\nt(\"p\", () => ss[0][1]);\nt(\"r\", () => aa[0].length);\nt(\"s\", () => aa[3].map((x) => x));\nt(\"t\", () => { const a = aa[0]; return a[i]; });\nt(\"u\", () => { const a = aa[0]; return a.length; });\nt(\"v\", () => { function f(r: U) { return r.id; } return f(us[9]); });\nt(\"w\", () => (us[9] as U).id);\nt(\"x\", () => us[9]!.id);\nt(\"y\", () => { const ff = () => us[9].id; return ff(); });\nt(\"z\", () => { ks[0].g = 1; return \"no\"; });\nt(\"aa\", () => { function* gen() { yield us[9].id; } const o: number[] = []; for (const x of gen()) o.push(x); return o; });\nt(\"bb\", () => { const r = us[5]; r.id++; return \"no\"; });\nt(\"cc\", () => { const r = us[5]; r.id += 1; return \"no\"; });\nt(\"dd\", () => { const k = ks[3]; k.v++; return \"no\"; });\nt(\"ee\", () => { const k = ks[3]; k.v += 2; return \"no\"; });\nt(\"ff\", () => { for (const x of us[4].tags) console.log(x); return \"no\"; });\nt(\"gg\", () => { const { id } = us[4]; return id; });\nt(\"hh\", () => { function p({ id }: U) { return id; } return p(us[4]); });\nt(\"ii\", () => us[4]?.nest.k);\nt(\"jj\", () => us[4]?.tags.length);\nt(\"kk\", () => ks[4]?.m());\nt(\"ll\", () => us[0]?.nest!.k);\nt(\"mm\", () => (us[4] as U | undefined)?.nest!.k);\nt(\"nn\", () => us[4]?.tags![0]);\nt(\"oo\", () => { const f: { h?: () => number }[] = []; return f[0]?.h?.(); });\nt(\"pp\", () => { const f: { h?: () => number }[] = [{}]; return f[0].h?.(); });\nt(\"qq\", () => { const f: { h?: () => number }[] = []; return f[0].h?.(); });\n(async () => { try { console.log(us[9].id); } catch (e) { console.log(\"async\", (e as Error).message); } })();",
  },
  {
    id: "r4-writes-paths-chains",
    ext: "ts",
    src: "import * as path from \"node:path\";\ntype E = { meta?: { k: string; n: number; a: number[] } };\nclass Q { x = 1; meta?: { k: string } }\nconst es: E[] = [{}];\nconst qs: Q[] = [new Q()];\nconst m = new Map<string, string>();\nconst xs: string[] = [];\nconst ar: number[][] = [];\nfunction t(label: string, f: () => unknown): void {\n  try { console.log(label, f()); } catch (e) { console.log(label, \"CAUGHT\", (e as Error).name, (e as Error).message); }\n}\nt(\"w1\", () => { es[0]!.meta!.k = \"q\"; return \"no\"; });\nt(\"w2\", () => { es[1]!.meta!.k = \"q\"; return \"no\"; });\nt(\"w6\", () => { es[0]!.meta!.a[0] = 1; return \"no\"; });\nt(\"w7\", () => { qs[0]!.meta!.k = \"q\"; return \"no\"; });\nt(\"w8\", () => { qs[0].meta!.k = \"q\"; return \"no\"; });\nt(\"w9\", () => { qs[3]!.x = 1; return \"no\"; });\nt(\"w10\", () => { ar[0]![0] = 1; return \"no\"; });\nt(\"w12\", () => { const r = es[0].meta!; r.k = \"q\"; return \"no\"; });\nt(\"w13\", () => { const q = qs[3]; q.x = 1; return \"no\"; });\nt(\"w14\", () => { const a = ar[0]; a[2] = 1; return \"no\"; });\nt(\"w15\", () => { const a = ar[0]; const i = 2; a[i] = 1; return \"no\"; });\nt(\"p1\", () => path.join(...xs, m.get(\"x\")!));\nt(\"p2\", () => path.join(\"a\", m.get(\"x\")!));\nt(\"p3\", () => path.basename(m.get(\"x\")!));\nt(\"p4\", () => path.resolve(m.get(\"x\")!));\nt(\"p5\", () => path.join(...xs, xs[3]));\nt(\"p6\", () => path.dirname(xs[2]));\nt(\"p7\", () => path.extname(xs[2] as string));\nt(\"p9\", () => path.resolve(...xs, m.get(\"y\")!));\ntype P = { b: { c: number }; s?: string; arr?: number[] };\nconst ps: P[] = [];\nconst ok: P[] = [{ b: { c: 1 } }];\nt(\"c1\", () => ps[0]?.b!.c);\nt(\"c2\", () => ps[0]?.b!.c.toFixed(1));\nt(\"c3\", () => (ps[0]?.b)!.c);\nt(\"c4\", () => ps[0]?.s!.length);\nt(\"c5\", () => ps[0]?.arr![0]);\nt(\"c6\", () => ps[0]?.arr!.map((x) => x).length);\nt(\"c7\", () => ok[0]?.s!.length);\nt(\"c8\", () => ok[0]?.b!.c);\nt(\"c9\", () => (ps[0]?.b as { c: number }).c);\nt(\"c10\", () => (ps[0]?.b as { c: number })?.c);\nt(\"c11\", () => ps[0]?.[\"b\"]!.c);",
  },
  {
    id: "r4-destructure-spread",
    ext: "ts",
    src: "type R = { x: number; s: string };\nclass C { x = 1; y = \"a\"; }\nconst rs: R[] = [];\nconst cs: C[] = [];\nconst aa: number[][] = [];\nconst m = new Map<string, R>();\nfunction get(): R { return rs[0]; }\nfunction t(label: string, f: () => unknown): void {\n  try { console.log(label, f()); } catch (e) { console.log(label, \"CAUGHT\", (e as Error).name, (e as Error).message); }\n}\nt(\"s2b\", () => { const r = rs[0]; const o = { ...r }; return [Object.keys(o).length, JSON.stringify(o), o.x]; });\nt(\"a1\", () => [...aa[0]]);\nt(\"d1\", () => { const { x } = rs[0]; return x; });\nt(\"d2\", () => { const r = rs[0]; const { x } = r; return x; });\nt(\"d3\", () => { const { x, s } = get(); return [x, s]; });\nt(\"d4\", () => { const { x } = m.get(\"zz\")!; return x; });\nt(\"d5\", () => { const { y } = cs[0]; return y; });\nt(\"d6\", () => { const c = cs[0]; const { y } = c; return y; });\nt(\"d7\", () => { const { x: renamed } = rs[0]; return renamed; });\nt(\"d8\", () => { const { x = 5 } = rs[0]; return x; });\nt(\"d9\", () => { const { ...rest } = rs[0]; return rest; });\nt(\"d10\", () => { const o = { r: rs[0] }; const { x } = o.r; return x; });\nt(\"d11\", () => { function f({ x }: R) { return x; } return f(rs[0]); });\nt(\"d12\", () => { const fn = ({ x }: R) => x; const r = rs[0]; return fn(r); });\nt(\"d13\", () => { let x = 0; ({ x } = rs[0]); return x; });\nt(\"d14\", () => { const [a] = aa[0]; return a; });\nt(\"d15\", () => { for (const { x } of [rs[0]]) console.log(x); return \"no\"; });\nt(\"d16\", () => { const o = { p: { r: rs[0] } }; const { p: { r: { x } } } = o; return x; });\nt(\"d17\", () => { const i = 0; const { x } = rs[i]; return x; });\nt(\"d18\", () => { const { x } = (rs[0]); return x; });\nt(\"d19\", () => { const { x } = rs[0]!; return x; });\nt(\"d20\", () => { const b = true; const { x } = b ? rs[0] : rs[1]; return x; });",
  },
  {
    id: "r4-spread-undefined-record",
    ext: "ts",
    src: "type R = { x: number; s: string };\nconst rs: R[] = [];\nconst r = rs[0];\nconst o = { ...r };\nconsole.log(o);\nconsole.log(Object.keys(o).length, JSON.stringify(o), \"x\" in o, o.x);\nconst p = { ...r, z: 1 };\nconsole.log(p);\nfor (const k in p) console.log(k);",
  },
  {
    id: "r4-reads-everywhere",
    ext: "ts",
    src: "interface U { id: number; name: string; tags: string[]; nest: { k: string; f?: () => number } }\nclass B { r!: U; list!: number[]; name = \"b\"; get rr() { return this.r.id; } hello() { return \"hi \" + this.r.name; } static make() { return new B(); } }\nclass S1 extends B { over() { return super.hello(); } }\nconst us: U[] = [];\nconst rc: Record<string, U> = {};\nconst rn: Record<string, number[]> = {};\nconst aa: number[][][] = [];\nconst ns: number[] = [];\nfunction t(label: string, f: () => unknown): void {\n  try { console.log(label, f()); } catch (e) { console.log(label, \"CAUGHT\", (e as Error).name, (e as Error).message); }\n}\nconst i = 3, neg = -1, fr = 2.5;\nconst u = ns[9];\nt(\"a1\", () => new B().r.id);\nt(\"a2\", () => new B().rr);\nt(\"a3\", () => new B().hello());\nt(\"a4\", () => new S1().over());\nt(\"a5\", () => new B().list[0]);\nt(\"a6\", () => new B().list[i]);\nt(\"a7\", () => new B().list.length);\nt(\"a8\", () => B.make().r.nest.k);\nt(\"b1\", () => rc[\"q\"].id);\nt(\"b2\", () => rn[\"q\"][i]);\nt(\"b3\", () => rn[\"q\"].length);\nconst key = \"zz\";\nt(\"b4\", () => rc[key].nest.k);\nt(\"c1\", () => aa[0][1][2]);\nt(\"c2\", () => aa[i][i]);\nt(\"c3\", () => aa[neg]);\nt(\"c4\", () => aa[neg][0]);\nt(\"c5\", () => aa[fr][0]);\nt(\"c6\", () => aa[u]);\nt(\"c7\", () => (aa[u] as number[][])[0]);\nt(\"c8\", () => (aa[0] as number[][])[u]);\nt(\"c9\", () => aa[0][u]);\nt(\"c10\", () => aa[0][NaN]);\nt(\"c11\", () => aa[0][1e21]);\nt(\"c12\", () => aa[0][-0]);\nt(\"c13\", () => { const a: number[] = aa[0][0]; return a.length; });\nt(\"d1\", () => { for (let j = 0; j < us[9].tags.length; j++) console.log(j); return \"no\"; });\nt(\"d2\", () => { let n = 0; while (n < us[9].id) n++; return n; });\nt(\"d3\", () => { switch (us[9].id) { case 1: return 1; default: return 2; } });\nt(\"d4\", () => `${us[9].name}!`);\nt(\"d5\", () => us[9].name + \"x\");\nt(\"d6\", () => us[9].id + 1);\nt(\"d7\", () => [us[9].id]);\nt(\"d8\", () => ({ a: us[9].id }));\nt(\"d9\", () => Math.max(us[9].id, 1));\nt(\"d10\", () => us[9].id > 1 ? \"y\" : \"n\");\nt(\"d11\", () => !us[9].id);\nt(\"d12\", () => us[9].id && 1);\nt(\"d13\", () => us[9].id ?? 1);\nt(\"d14\", () => typeof us[9].id);\nt(\"d15\", () => typeof us[9]);\nt(\"d16\", () => us[9] === undefined);\nt(\"d17\", () => us[9]?.nest?.f?.());\nt(\"d18\", () => us[9].nest.f?.());\nt(\"e1\", () => [1].map((x) => us[x].id));\nt(\"e2\", () => [1].filter((x) => us[x].id > 0));\nt(\"e3\", () => [us[0]].map((q) => q.id));\nt(\"e4\", () => [us[0]].filter((q) => q?.id === 1).length);\nt(\"e5\", () => { const fn = (q: U) => q.nest.k; return fn(us[2]); });\nt(\"e6\", () => { function* g(q: U) { yield q.id; } const o: number[] = []; for (const x of g(us[2])) o.push(x); return o; });\nclass C2 { c: U; constructor(q: U) { this.c = q; } get id() { return this.c.id; } }\nt(\"f1\", () => new C2(us[2]).id);\nt(\"f2\", () => new C2(us[2]).c.id);\nt(\"f3\", () => { const cs: C2[] = []; return cs[1].id; });\nt(\"f4\", () => { const cs: C2[] = []; return cs[1].c.nest; });\nasync function af(q: U): Promise<number> { await null; return q.id; }\naf(us[5]).then((v) => console.log(\"then\", v)).catch((e) => console.log(\"rej\", String(e)));\nasync function ag(): Promise<void> { try { const q = await Promise.resolve(us[5]); console.log(q.id); } catch (e) { console.log(\"ag\", (e as Error).message); } }\nag();\nsetTimeout(() => { try { console.log(us[4].id); } catch (e) { console.log(\"tm\", (e as Error).message); } }, 0);",
  },
  {
    id: "r4-promises-generators",
    ext: "ts",
    src: "interface U { id: number }\nconst us: U[] = [];\nconst ss: string[] = [];\nconst aa: number[][] = [];\nasync function a1(): Promise<void> { try { const q = await Promise.resolve(us[5]); console.log(q === undefined); console.log(q.id); } catch (e) { console.log(\"a1\", (e as Error).message); } }\nasync function a2(): Promise<void> { try { const q = await Promise.resolve(ss[5]); console.log(q === undefined); console.log(q.length); } catch (e) { console.log(\"a2\", (e as Error).message); } }\nasync function a3(): Promise<void> { try { const q = await Promise.resolve(aa[5]); console.log(q === undefined); console.log(q.length); } catch (e) { console.log(\"a3\", (e as Error).message); } }\nasync function get(): Promise<U> { return us[5]; }\nasync function a4(): Promise<void> { try { const q = await get(); console.log(q === undefined); console.log(q.id); } catch (e) { console.log(\"a4\", (e as Error).message); } }\nPromise.resolve(us[5]).then((q) => console.log(\"t1\", q === undefined)).catch(() => console.log(\"no\"));\nPromise.resolve(ss[5]).then((q) => console.log(\"t2\", q === undefined));\nPromise.resolve(aa[5]).then((q) => { try { console.log(q[0]); } catch (e) { console.log(\"t3\", (e as Error).message); } });\nnew Promise<U>((res) => res(us[5])).then((q) => console.log(\"t4\", q === undefined));\nfunction* g(): Generator<U> { yield us[5]; }\nfor (const v of g()) console.log(\"g1\", v === undefined);\nconst it = g(); const n = it.next(); console.log(\"g2\", n.value === undefined, n.done);\na1().then(() => a2()).then(() => a3()).then(() => a4());\nconst mp = new Map<string, U>(); mp.set(\"a\", us[5]); console.log(\"m1\", mp.get(\"a\") === undefined, mp.size);\nfor (const [k, v] of mp) console.log(\"m2\", k, v === undefined);\nconsole.log(\"arr\", [us[5]].length, [us[5]].map((x) => x === undefined));\nconst tup: [U, number] = [us[5], 1]; console.log(\"tup\", tup[0] === undefined);\nconst box = { v: us[5] }; console.log(\"box\", box.v === undefined);\nclass H { v: U = us[5]; } console.log(\"cls\", new H().v === undefined);",
  },
  {
    id: "r4-promises-generators-scalars",
    ext: "ts",
    src: "const bs: boolean[] = [];\nconst ns: number[] = [];\nconst fs_: (() => number)[] = [];\nasync function main(): Promise<void> {\n  const b = await Promise.resolve(bs[1]);\n  console.log(b, typeof b, b === undefined);\n  const n = await Promise.resolve(ns[1]);\n  console.log(n, typeof n, n === undefined);\n}\nmain();\nfunction* gb(): Generator<boolean> { yield bs[2]; }\nfunction* gn(): Generator<number> { yield ns[2]; }\nfunction* gs(): Generator<string> { const a: string[] = []; yield a[2]; }\nconsole.log(gb().next().value === undefined, gn().next().value === undefined, gs().next().value === undefined);\nconsole.log(gb().next(), gn().next());",
  },
  {
    id: "f4-generic-catch",
    ext: "ts",
    src: "interface U { id: number; name: string }\nconst us: U[] = [{ id: 1, name: \"a\" }];\nfunction get(id: number): U { return us.find((u) => u.id === id)!; }\ntry { console.log(get(9).name); } catch { console.log(\"not found\"); }\nconsole.log(\"after\");",
  },
  {
    id: "f5-join-spread",
    ext: "ts",
    src: "import * as path from \"node:path\";\nconst xs: string[] = [];\nconst m = new Map<string, string>();\ntry { console.log(path.join(...xs, m.get(\"x\")!)); } catch { console.log(\"bad path\"); }\nconsole.log(\"after\");\nconsole.log(path.resolve(m.get(\"x\")!, \"/abs\"));",
  },
  {
    id: "f8-write-through-bang",
    ext: "ts",
    src: "type E = { meta?: { k: string } };\nconst es: E[] = [{}];\ntry { es[0]!.meta!.k = \"q\"; } catch (e) { console.log(String(e)); }",
  },
  {
    id: "f9-chain-bang",
    ext: "ts",
    src: "type P = { b: { c: number } };\nconst ps: P[] = [];\nconsole.log(ps[0]?.b!.c);",
  },
  {
    id: "g17-spread-binding",
    ext: "ts",
    src: "const rs: { x: number; s: string }[] = [];\nconst r = rs[0];\nconsole.log({ ...r });",
  },
  {
    id: "i-run-time-index",
    ext: "ts",
    src: "const aa: number[][] = [];\nconst i = 7;\nconst f = () => { console.log(\"index ran\"); return 2; };\ntry { console.log(aa[0][i]); } catch (e) { console.log(String(e)); }\ntry { console.log(aa[1][f()]); } catch (e) { console.log(String(e)); }\nconst ss: string[] = [];\ntry { console.log(ss[0][i]); } catch (e) { console.log(String(e)); }",
    id: "r4-s01-spread-over",
    ext: "ts",
    src: `const base = { port: 80, host: "x" };
const over = JSON.parse('{"host":"y"}') as { port: number; host: string };
const cfg = { ...base, ...over };
console.log(cfg, cfg.port);
console.log(Object.assign({}, base, over));`,
  },
  {
    id: "r4-s02-spread-pos",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const d0 = { note: "d" };
const a = { ...d0, ...w };
console.log(a.note, a.a, "note" in a, Object.keys(a).length);
const b = { ...w, note: "e" };
console.log(b);
const c = { ...w };
console.log(c, "note" in c, Object.keys(c));
const d = { ...w, y: 2 };
console.log(d, JSON.stringify(d));
const e = { n: { ...w } };
console.log(e);
const f = [{ ...w }];
console.log(f);`,
  },
  {
    id: "r4-s03-assign-target",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const t = { a: 0, note: "keep" };
Object.assign(t, w);
console.log(t);
const t2 = Object.assign({}, w);
console.log(t2, Object.keys(t2));
Object.assign(w, { note: "set" });
console.log(w, Object.keys(w), "note" in w);`,
  },
  {
    id: "r4-s04-assign-any",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const v: any = w;
console.log(Object.keys(v), v, "note" in v, v.note, JSON.stringify(v));
const q: any = {};
Object.assign(q, w);
console.log(q);
const z: any = { ...w };
console.log(z, Object.keys(z));`,
  },
  {
    id: "r4-s05-keys",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
console.log(Object.keys(w), Object.values(w), Object.entries(w));
for (const k in w) console.log(k);
console.log(Object.fromEntries(Object.entries(w)));
console.log(JSON.stringify(w), JSON.stringify({ w }), JSON.stringify([w]));
console.log(w, [w], { w }, new Map([["k", w]]));`,
  },
  {
    id: "r4-s06-clone",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const c = structuredClone(w);
console.log(c, Object.keys(c), "note" in c);`,
  },
  {
    id: "r4-s07-deepeq",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
import assert from "node:assert";
const ok = JSON.parse('{"a":1}') as R;
assert.deepStrictEqual(w, ok);
try { assert.deepStrictEqual(w, { a: 1, note: "" }); console.log("eq"); } catch (e) { console.log("ne"); }
console.log("done");`,
  },
  {
    id: "r4-s08-rest",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const { a, ...rest } = w;
console.log(a, rest, Object.keys(rest));
const { note, ...r2 } = w;
console.log(note, r2);`,
  },
  {
    id: "r4-s09-union",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
type U = R | number;
const u: U = w;
console.log(u);
if (typeof u !== "number") console.log(Object.keys(u), "note" in u, { ...u });
const o = w as R | undefined;
console.log(o);
if (o) console.log(Object.keys(o));`,
  },
  {
    id: "r4-s10-class",
    ext: "ts",
    src: `class C { a: number; note: string; constructor(r: { a: number; note: string }) { this.a = r.a; this.note = r.note; } }
const c = new C(JSON.parse('{"a":1}') as { a: number; note: string });
console.log(c, c.note === undefined);`,
  },
  {
    id: "r4-s11-maps",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const m = new Map<string, R>([["k", w]]);
for (const [k, v] of m) console.log(k, v, Object.keys(v));
console.log([...m.values()].map((v) => ({ ...v })));`,
  },
  {
    id: "r4-s12-as",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const x = { ...w } as R;
console.log(x, Object.keys(x));
const y = { ...w, a: 2 } as R;
console.log(y);
const copy: R = { a: w.a, note: w.note };
console.log(copy.note === undefined);`,
  },
  {
    id: "r4-s13-nested",
    ext: "ts",
    src: `type I = { k: string; v: number };
type O = { i: I; list: I[] };
const o = JSON.parse('{"i":{"k":"a"},"list":[{"v":1}]}') as O;
console.log(o, Object.keys(o.i), "v" in o.i, JSON.stringify(o));
console.log({ ...o.i }, o.list.map((e) => ({ ...e })), o.list.map((e) => Object.keys(e)));`,
  },
  {
    id: "r4-s14-explicit",
    ext: "ts",
    src: `type R = { a: number; note: string };
const d: any = { a: 1, note: undefined };
const w = d as R;
console.log(Object.keys(w), "note" in w, w);`,
  },
  {
    id: "r4-s15x-no-other",
    ext: "ts",
    src: `type R = { a: number; note: string };
const d: any = { a: 1, note: undefined };
const w = d as R;
console.log(Object.keys(w), "note" in w, w, { ...w }, Object.assign({}, w));
const v: any = w;
console.log(v, Object.keys(v));`,
  },
  {
    id: "r4-s16-fn-arg",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
function show(r: R) { return Object.keys(r).join(","); }
console.log(show(w));
function cp(r: R): R { return { ...r }; }
console.log(cp(w), Object.keys(cp(w)));
const fs2: any = (r: R) => Object.keys(r);
console.log(fs2({ a: 1 }));`,
  },
  {
    id: "r4-s17-array-of",
    ext: "ts",
    src: `type R = { a: number; note: string };
const rs = JSON.parse('[{"a":1},{"a":2,"note":"n"}]') as R[];
console.log(rs, rs.map((r) => Object.keys(r).length), JSON.stringify(rs));
console.log(rs.map((r) => ({ ...r, x: 1 })));`,
  },
  {
    id: "r4-s18-merge-all",
    ext: "ts",
    src: `type C = { p: number; q: string; r: boolean };
const dflt: C = { p: 1, q: "a", r: true };
const a = JSON.parse('{"p":2}') as C;
const b = JSON.parse('{"q":"z"}') as C;
const m = { ...dflt, ...a, ...b };
console.log(m);
console.log(Object.assign({}, dflt, a, b));
console.log(Object.assign(dflt, a));`,
  },
  {
    id: "r4-s19-opt-later",
    ext: "ts",
    src: `type O = { p?: number; q: string };
const a = { p: 1, q: "a" };
const b: O = { q: "b" };
const m = { ...a, ...b };
console.log(m);
const c = { p: 2, q: "c" };
const n = { ...b, ...c };
console.log(n.p, n.q);
const o = { ...a, ...b, ...c, ...b };
console.log(o);`,
  },
  {
    id: "r4-s20-effect",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
function f() { console.log("f"); return JSON.parse('{"a":2}') as R; }
const r = f();
const d = { note: "dflt", a: 0 };
const t = { ...d, ...r };
console.log(t.a, t.note);
const t3 = { ...t, ...w, ...r };
console.log(t3.a, t3.note);`,
  },
  {
    id: "r4-s21-dyn-target",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const d: any = { note: "keep" };
Object.assign(d, w);
console.log(d);
function ks(o: any) { return Object.keys(o); }
console.log(ks(w), ks({ ...w }), ks([w][0]));`,
  },
  {
    id: "r4-s22-narrow",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
type N = { a: number };
const n: N = w;
console.log(n, Object.keys(n));`,
  },
  {
    id: "r4-s24-keys-of-explicit",
    ext: "ts",
    src: `type R = { a: number; note: string };
const xs: string[] = [];
const w: R = { a: 1, note: xs[3] };
console.log(Object.keys(w), { ...w }, Object.assign({}, w), "note" in w, JSON.stringify(w));
const q: any = w;
console.log(Object.keys(q), q);
const base = { a: 0, note: "keep" };
console.log({ ...base, ...w }, Object.assign({}, base, w));`,
  },
  {
    id: "r4-s25-dyn-spread",
    ext: "mjs",
    src: `const w = JSON.parse('{"a":1}');
console.log(Object.assign({}, { a: 0, n: 1 }, w), Object.keys(w));`,
  },
  {
    id: "r4-s27-in-nested",
    ext: "ts",
    src: `type I = { k: string; v: number };
type O = { i: I };
const o = JSON.parse('{"i":{"k":"a"}}') as O;
const c = { ...o };
console.log(c, Object.keys(c.i), { ...o.i });
const d = structuredClone(o);
console.log(d);
const dd: any = o;
console.log(dd, Object.keys(dd.i));`,
  },
  {
    id: "r4-s29-array-fields",
    ext: "ts",
    src: `type T = { n: string[]; m: { x: number } };
const t = JSON.parse('{"n":["a"]}') as T;
console.log(t, Object.keys(t), "m" in t, JSON.stringify(t));
const c = { ...t };
console.log(c);
const base = { n: ["z"], m: { x: 1 } };
console.log({ ...base, ...t });
const v: any = t;
console.log(v);`,
  },
  {
    id: "r4-s30-bool-num",
    ext: "ts",
    src: `type T = { b: boolean; n: number; s: string };
const t = JSON.parse('{}') as T;
const base: T = { b: true, n: 5, s: "s" };
console.log({ ...base, ...t }, Object.assign({}, base, t), Object.keys(t), t);
Object.assign(base, t);
console.log(base);`,
  },
  {
    id: "r4-e01-exists",
    fsHost: true,
    ext: "ts",
    src: `import * as fs from "node:fs";
const cfg = JSON.parse("{}") as { path?: string };
console.log(fs.existsSync(cfg.path!));
const m = new Map<string, string>();
console.log(fs.existsSync(m.get("x")!));
const d: any = JSON.parse("{}");
console.log(fs.existsSync(d.u));
const xs: string[] = [];
console.log(fs.existsSync(xs[3]));`,
  },
  {
    id: "r4-q-exists2",
    fsHost: true,
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.existsSync("/") && fs.existsSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-bufFrom",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => Buffer.from(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-encC",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => encodeURIComponent(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-decC",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => decodeURIComponent(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-enc",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => encodeURI(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-realpath",
    fsHost: true,
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.realpathSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-url",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => new URL(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-stat",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.statSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-lstat",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.lstatSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-access",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.accessSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-read",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.readFileSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-write",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.writeFileSync(xs[3], "a"));
console.log("after");`,
  },
  {
    id: "r4-q-mkdir",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.mkdirSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-readdir",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.readdirSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-unlink",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.unlinkSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-rm",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.rmSync(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-copy",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.copyFileSync(xs[3], "x"));
console.log("after");`,
  },
  {
    id: "r4-q-writedata",
    ext: "ts",
    src: `import * as fs from "node:fs";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => fs.writeFileSync("/tmp/nope/x", xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pjoin",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.join(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pjoin2",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.join("a", xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pbase",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.basename(m.get("x")!));
console.log("after");`,
  },
  {
    id: "r4-q-pres",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.resolve(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pdir",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.dirname(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pext",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.extname(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pabs",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.isAbsolute(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-pnorm",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.normalize(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-prel",
    ext: "ts",
    src: `import * as path from "node:path";
function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => path.relative("a", xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-btoa",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => btoa(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-q-env",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => process.env[xs[3]]);
console.log("after");`,
  },
  {
    id: "r4-q-num",
    ext: "ts",
    src: `function t(f: () => unknown) { try { console.log(f()); } catch (e) { console.log((e as NodeJS.ErrnoException).code, (e as Error).message); } }
const xs: string[] = [];
const m = new Map<string, string>();
t(() => Number(xs[3]));
console.log("after");`,
  },
  {
    id: "r4-t01-accessor",
    ext: "ts",
    src: `const n: any = 5;
const o = { get g() { "use strict"; try { n.x = 1; return "no throw"; } catch (e) { return String(e); } }, set s(v: number) { "use strict"; try { n.y = v; console.log("no"); } catch (e) { console.log(String(e)); } } };
console.log(o.g);
o.s = 1;`,
  },
  {
    id: "r4-t02-fnlike",
    ext: "cjs",
    src: `const n = 5;
function w(v) { v.x = 1; return "ok"; }
function t(f) { try { console.log(f(n)); } catch (e) { console.log(String(e)); } }
t(w);
t(function (v) { "use strict"; v.x = 1; return "ok"; });
t((v) => { "use strict"; v.x = 1; return "ok"; });
t((v) => { v.x = 1; return "ok"; });
class C { m(v) { v.x = 1; return "ok"; } static s(v) { v.x = 1; return "ok"; } }
t((v) => new C().m(v)); t((v) => C.s(v));
function outer() { "use strict"; return (v) => { v.x = 1; return "ok"; }; }
t(outer());
function outer2() { "use strict"; function inner(v) { v.x = 1; return "ok"; } return inner; }
t(outer2());`,
  },
  {
    id: "r4-t03-gen",
    ext: "cjs",
    src: `function* g(v) { "use strict"; v.x = 1; yield 1; }
try { for (const x of g(5)) console.log(x); } catch (e) { console.log(String(e)); }
async function af(v) { "use strict"; v.x = 1; }
af(5).catch((e) => console.log(String(e)));`,
  },
  {
    id: "r4-t04-class-ctor",
    ext: "cjs",
    src: `const n = 5;
class C { constructor(v) { v.x = 1; this.ok = "c"; } get g() { n.x = 1; return "ok"; } }
try { console.log(new C(n).ok); } catch (e) { console.log(String(e)); }`,
  },
  {
    id: "r4-t05-sloppy-ctor",
    ext: "ts",
    src: `const n: any = 5;
function F(this: any) { n.x = 1; return 1; }
class D { m() { n.x = 1; return "ok"; } }
try { console.log(new D().m()); } catch (e) { console.log(String(e)); }
const q = { get a() { n.x = 1; return "sloppy getter ok"; } };
console.log(q.a);`,
  },
  {
    id: "r4-t05b-ts-ctor",
    ext: "ts",
    src: `const n: any = 5;
class C { constructor(v: any) { v.x = 1; } }
try { new C(n); console.log("ok"); } catch (e) { console.log(String(e)); }
function s() { n.y = 1; return "sloppy ok"; }
console.log(s());
function ss() { "use strict"; n.y = 1; return "ok"; }
try { console.log(ss()); } catch (e) { console.log(String(e)); }`,
  },
  {
    // S119 (i): both a missing key and an explicit undefined: the fence
    id: "r4-s15-both",
    ext: "ts",
    src: `type R = { a: number; note: string };
const other = JSON.parse('{"a":1}') as R;
const d: any = { a: 1, note: undefined };
const w = d as R;
console.log(Object.keys(w), "note" in w, w, other.a);`,
    fence: { stdout: "", stderr: BOTH_KEYS },
  },
  {
    id: "r4-s23-write-back",
    ext: "ts",
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
w.note = "x";
console.log(w, Object.keys(w));
const u2 = JSON.parse('{"a":1}') as R;
const xs: string[] = [];
u2.note = xs[3];
console.log(Object.keys(u2), u2);`,
    fence: { stdout: "{ a: 1, note: 'x' } [ 'a', 'note' ]\n", stderr: BOTH_KEYS },
  },
  {
    // a crossing into --dynamic code: a view of a record with a missing key
    id: "r4-s26-island",
    ext: "ts",
    dynamic: true,
    src: `type R = { a: number; note: string };
const w = JSON.parse('{"a":1}') as R;
const v: any = w;
console.log(v, JSON.stringify(v), v.note);
const x: any = v;
console.log(x.a);`,
  },
  {
    // S115: \`undefined\` is no wrong kind for a typed slot on these lanes
    id: "r4-s115-undefined-writes",
    ext: "ts",
    dynamic: true,
    src: `const t: number[] = [1, 2];
const v: any = t;
v[0] = undefined;
console.log(t[0], v[0], t.length);
const r = { x: 1, s: "a" };
const w: any = r;
w.x = undefined;
w.s = undefined;
console.log(r.x, r.s, w.x, w.s, r, JSON.stringify(r));`,
  },
  {
    // the lead's sweep of round 4: reads, writes and calls through slots
    // holding undefined, in one try-per-form program (uncaught async last)
    id: "r4-sweep-lead",
    ext: "ts",
    src: `type R = { port: number; host: string; meta?: { k: string } };
const t = (f: () => unknown) => { try { console.log(f()); } catch (e) { console.log("E", (e as Error).name, (e as Error).message); } };
const rs: R[] = [];
const ms = new Map<string, R>();
const g = (): R => rs[0];
t(() => g().host);
t(() => g().meta?.k);
t(() => ms.get("a")!.port + 1);
t(() => rs[0]!.meta!.k.length);
t(() => rs[1]?.meta!.k.length);
t(() => (rs[0] as R).host.length);
t(() => { const r = g(); const { host } = r; return host; });
t(() => { const [a] = rs; return a.port; });
t(() => { for (const r of [g()]) return r.port; return 0; });
t(() => [g()].map((r) => r.port));
class C { v = 1; m() { return this.v; } get w() { return 2; } }
const cs: C[] = [];
t(() => cs[0].v);
t(() => cs[0].m());
t(() => cs[0].w);
t(() => { const i = 3; return rs[i].host; });
t(() => { const a: number[][] = []; const i = 2; return a[i][0]; });
t(() => { const a: number[][] = []; return a[0].length; });
t(() => { const f: (() => number)[] = []; return f[0](); });
t(() => { const f: (() => number)[] = []; const i = 0; return f[i](); });
t(() => { const f: Record<string, () => number> = {}; return f["k"](); });
t(() => { rs[0].port = 1; return 1; });
t(() => { cs[0].v = 1; return 1; });`,
  },
  {
    // round 5: the key observers over a slot holding undefined, through
    // `!`, `as`, a return, a binding, an optional-field record, an index
    // signature and a class slot
    id: "r5-object-observers",
    ext: "ts",
    src: `type R = { x: number; s: string };
type O = { x: number; s?: string };
const t = (f: () => unknown) => { try { console.log(f()); } catch (e) { console.log("E", (e as Error).name, (e as Error).message); } };
const rs: R[] = [];
const os: O[] = [];
const m = new Map<string, R>();
const get = (i: number): R => rs.find((u) => u.x === i)!;
const ret = (): R => rs[0];
const ix: Record<string, number>[] = [];
const r = rs[0];
const o = os[0];
const q = m.get("k") as R;
t(() => Object.keys(r));
t(() => Object.keys(o));
t(() => Object.keys(q));
t(() => Object.keys(ret()));
t(() => Object.keys(get(1)));
t(() => Object.keys(m.get("z")!));
t(() => Object.keys(m.get("z") as R));
t(() => Object.keys(rs[1]));
t(() => Object.keys(ix[0]));
t(() => Object.values(r));
t(() => Object.values(ix[0]));
t(() => Object.values(o));
t(() => Object.values(m.get("z")!));
t(() => Object.values(rs[1]).length);
t(() => Object.entries(r));
t(() => Object.entries(ix[0]));
t(() => Object.entries(ret()));
t(() => { for (const [k, v] of Object.entries(r)) console.log(k, v); return 0; });
t(() => Object.hasOwn(r, "x"));
t(() => Object.hasOwn(o, "s"));
t(() => Object.hasOwn(ret(), "x"));
t(() => Object.hasOwn(rs[1], "x"));
t(() => Object.hasOwn(q, "x"));
t(() => Object.hasOwn(m.get("z")!, "x"));
t(() => Object.assign(r, { x: 2 }));
t(() => Object.assign(ret(), { x: 2, s: "a" }));
t(() => Object.assign(rs[1], { x: 2, s: "a" }));
t(() => "x" in r);
t(() => "y" in r);
t(() => "s" in o);
t(() => "x" in q);`,
  },
  {
    // round 5: method calls on a slot holding undefined that the tier
    // answers statically
    id: "r5-method-observers",
    ext: "ts",
    src: `type R = { x: number; s: string };
const t = (f: () => unknown) => { try { console.log(f()); } catch (e) { console.log("E", (e as Error).name, (e as Error).message); } };
const rs: R[] = [];
const ss: string[] = [];
const ns: number[] = [];
const bs: boolean[] = [];
const m = new Map<string, R>();
const us: R[] = [];
const get = (i: number): R => us.find((u) => u.x === i)!;
class C { v = 1; }
class D { v = 1; toString() { return "D!"; } valueOf() { return 5; } }
const cs: C[] = [];
const ds: D[] = [];
const r = rs[0];
const c = cs[0];
const d = ds[0];
const u = ss[0];
const n = ns[0];
const b = bs[0];
t(() => r.toString());
t(() => rs[1].toString());
t(() => get(9).toString());
t(() => m.get("z")!.toString());
t(() => (m.get("z") as R).toString());
t(() => c.toString());
t(() => cs[1].toString());
t(() => d.toString());
t(() => ds[1].toString());
t(() => d.valueOf());
t(() => u.toString());
t(() => n.toString());
t(() => b.toString());
t(() => u.hasOwnProperty("length"));
t(() => u.hasOwnProperty("0"));
t(() => n.hasOwnProperty("x"));
t(() => b.hasOwnProperty("x"));
t(() => ns[1].toFixed(2));`,
  },
  {
    // round 5 lead check: the guarded `in` evaluates a computed receiver
    // once, for an optional field and a required undefined-armed one
    id: "r5-in-once",
    ext: "ts",
    src: `type R = { a: number; note?: string };
type Q = { b: number; note: string | undefined };
const us: R[] = [{ a: 1 }, { a: 2, note: "n" }];
const qs: Q[] = [{ b: 1, note: undefined }];
let calls = 0;
function get(i: number): R { calls++; return us.find((u) => u.a === i)!; }
function getQ(i: number): Q { calls++; return qs.find((u) => u.b === i)!; }
console.log("note" in get(2), calls);
console.log("note" in get(1), calls);
console.log("note" in getQ(1), calls);
try { console.log("note" in get(9)); } catch (e) { console.log(String(e)); }
try { console.log("note" in getQ(9)); } catch (e) { console.log(String(e)); }
console.log(calls);`,
  },
  {
    id: "v-strand",
    ext: "ts",
    src: `interface Base { a: number }
interface Ext { a: number; b: string }
interface Handler { handle(x: Base): string }
const h: Handler = { handle(x: Ext) { return "got " + x.a + " " + typeof x.b; } };
let out: string;
try { out = h.handle({ a: 1 }); } catch (e) { out = "fallback " + (e as Error).message; }
console.log(out);`,
    fence: { stdout: "", stderr: /^tsinter: unsupported: a '.*' function invoked through a '.*' slot .*the call has no exact lowering\) \[SC1090 at a call through a function-typed slot\]\n$/ },
  },
  {
    id: "n-dyncheck",
    ext: "ts",
    src: `interface Cfg { port: number }
let label: string;
try {
  const c = JSON.parse('{"port":"80"}') as Cfg;
  const p: number = c.port;
  label = "port " + p;
} catch (e) {
  label = "invalid config";
}
console.log(label);`,
    fence: { stdout: "", stderr: SC1100("expected number at $.port, got string") },
  },
  {
    id: "q-narrow",
    ext: "ts",
    src: `function get(): unknown { return JSON.parse('"hello"'); }
let s: string;
try { const n = get() as number; s = "num " + n.toFixed(1); } catch (e) { s = "caught " + (e as Error).message; }
console.log(s);`,
    fence: { stdout: "", stderr: SC1100("expected number at $, got string") },
  },
  {
    id: "p-recordset",
    ext: "ts",
    src: `interface Mixed { known: number; [k: string]: unknown }
function setKey(r: Mixed, k: string, v: unknown) { r[k] = v; }
const r: Mixed = { known: 1 };
try { setKey(r, "known", "x"); console.log("set", r.known); } catch (e) { console.log("caught"); }`,
    fence: { stdout: "", stderr: SC1100("expected number at $.known, got string") },
  },
  {
    id: "y3-plus-undefined-capture",
    ext: "ts",
    src: `const m = "x".match(/(a)?x/)!;
console.log(m[1] < "a", m[1] > "a", m[1] + 1);`,
    fence: { stdout: "", stderr: PLUS_NAN(2) },
  },
  {
    id: "y3b-the-rest",
    ext: "ts",
    src: `const m = "x".match(/(a)?x/)!;
console.log(m[1] < "a", m[1] > "a", "s" + m[1], m[1] + "s");
console.log(m.slice(1), m.filter((x) => x !== undefined));
const set = new Set(m); console.log(set.size);
console.log(m[1]?.length, m[1]?.toUpperCase());
if (m[1]) console.log("truthy"); else console.log("falsy");`,
  },
  {
    id: "y5-map-capture",
    ext: "ts",
    src: `const m = "x".match(/(a)?x/)!;
const mp = new Map<string, string>([["k", m[1]]]);
console.log(mp.get("k"), mp.has("k"));`,
  },
  {
    id: "y6-plus-undefined-slot",
    ext: "ts",
    src: `const xs: string[] = [];
console.log(xs[3] + 1, xs[3] + xs[4], xs[3] + true);`,
    fence: { stdout: "", stderr: PLUS_NAN(2) },
  },
  {
    id: "y6b-undefined-plus-string",
    ext: "ts",
    src: `const n: number[] = [];
console.log(n[2] + "s");
const xs: string[] = [];
console.log(xs[3] + "t", "t" + xs[3]);`,
  },
  {
    id: "y7-map-slot",
    ext: "ts",
    src: `const xs: string[] = [];
const mp = new Map<string, string>([["k", xs[3]]]);
console.log(mp.get("k"), mp.has("k"));`,
  },
  {
    id: "y8-map-read-twice",
    ext: "ts",
    src: `const m = "x".match(/(a)?x/)!;
const mp = new Map<string, string>([["k", m[1]]]);
const g = mp.get("k");
console.log(g);
console.log(mp.get("k"), 1);`,
  },
  {
    id: "x3-length",
    ext: "ts",
    src: `const m = /(a)|(b)/.exec("a")!;
console.log("before");
let r: string;
try { r = "len " + m[2].length; } catch (e) { r = "caught " + (e as Error).message; }
console.log(r);`,
  },
  {
    id: "x4-method",
    ext: "ts",
    src: `function parse(v: string) {
  const m = /^(\\d+)\\.(\\d+)(?:-(\\w+))?$/.exec(v);
  if (!m) return "bad";
  try { return m[3].toUpperCase(); } catch (e) { return "no pre: " + (e as Error).message; }
}
console.log(parse("1.2-beta"));
console.log(parse("1.2"));`,
  },
  {
    id: "z1-in-hole",
    ext: "mjs",
    src: `function has(k, o) { return k in o; }
const arr = [1, , 3];
console.log(has(0, arr), has("length", arr));
try { console.log(has(1, arr)); } catch (e) { console.log("caught"); }`,
    fence: {
      stdout: "true true\n",
      stderr: "tsinter: unsupported: 'in' or Object.hasOwn over an array index that may be a hole (a write past an array's end leaves undefined where Node keeps a hole — SEMANTICS.md S119) [SC1090]\n",
    },
  },
  {
    id: "z1b-in-keys",
    ext: "mjs",
    src: `function has(k, o) { return k in o; }
const a2 = [1, 2, 3, 4];
console.log(has("01", a2), has(-0, a2), has("-0", a2), has(1.0, a2), has("3", a2), has("+1", a2), has(" 1", a2));
console.log(has(1, { 1: "a" }), has("1.0", { 1: "a" }), has(1.5, { "1.5": 1 }));`,
  },
  {
    id: "z6-in-prototype",
    ext: "mjs",
    src: `function has(k, o) { return k in o; }
function fn(a, b) {}
console.log(has("name", fn), has("length", fn), has("x", fn));
console.log(has("prototype", fn));`,
  },
  {
    id: "a3-path-param",
    ext: "cjs",
    src: `const path = require("path");
function t(f) { try { console.log(f()); } catch (e) { console.log(e.name, e.code, e.message); } }
const five = JSON.parse("5"), obj = JSON.parse("{}");
t(() => path.join("a", five));
t(() => path.basename(obj));
t(() => path.dirname(five));
t(() => path.extname(null));
t(() => path.resolve("a", five));
t(() => path.normalize(obj));
t(() => path.isAbsolute(five));
t(() => path.relative("a", obj));`,
  },
  {
    id: "a3-url-tostring",
    ext: "cjs",
    src: `function t(f) { try { console.log(f()); } catch (e) { console.log(e.name, e.code, e.message); } }
const five = JSON.parse("5");
t(() => new URL(five).href);
t(() => new URL(JSON.parse("{}")).href);
t(() => new URL("x").href);
t(() => new URL(JSON.parse('"http://a.b/c"')).href);`,
  },
  {
    id: "a3-path-fs-params",
    ext: "cjs",
    src: `const path = require("path");
const fs = require("fs");
function t(f) { try { f(); console.log("ok"); } catch (e) { console.log(e.name, e.code, e.message); } }
const xs = [];
t(() => { path.join("a", 5); });
t(() => { path.basename({}); });
t(() => { path.dirname(xs[3]); });
t(() => { path.resolve("a", null); });
t(() => { path.basename("a", 5); });
t(() => { path.posix.join("a", 5); });
t(() => { path.win32.basename(5); });
t(() => { fs.readFileSync({}, "utf8"); });
t(() => { fs.readFileSync({}); });
t(() => { fs.writeFileSync("/tmp/x-s2r", {}); });
t(() => { fs.writeFileSync({}, "x"); });
t(() => { fs.statSync(5); });
t(() => { fs.mkdirSync(true); });
t(() => { fs.copyFileSync("a", 5); });
t(() => { fs.unlinkSync({}); });
t(() => { fs.mkdtempSync(5); });
t(() => { fs.appendFileSync({}, "x"); });
t(() => { fs.chmodSync(5, 0o644); });
t(() => { fs.openSync({}, "r"); });
t(() => { fs.accessSync(null); });
t(() => { fs.readdirSync(5); });
t(() => { fs.rmSync({}); });
t(() => { fs.lstatSync(5); });`,
  },
  {
    id: "b9-sloppy-string-number",
    ext: "cjs",
    src: `const s = JSON.parse('"abc"'), n = JSON.parse("5");
s[0] = "x"; s.length = 1; s.foo = 1; n.x = 1;
console.log(s, n);
function st() { "use strict"; try { s[0] = "x"; } catch (e) { console.log(e.message); } try { n.x = 1; } catch (e) { console.log(e.message); } }
st();`,
  },
  {
    id: "b9-sloppy-ts",
    ext: "ts",
    src: `const s: any = JSON.parse('"abc"');
s[0] = "x"; s.length = 1; s.foo = 1;
console.log(s);`,
  },
  {
    id: "b9-esm-strict",
    ext: "mjs",
    src: `const s = JSON.parse('"abc"'), n = JSON.parse("5");
try { s[0] = "x"; } catch (e) { console.log(e.name, e.message); }
try { s.length = 1; } catch (e) { console.log(e.name, e.message); }
try { s.foo = 1; } catch (e) { console.log(e.name, e.message); }
try { n.x = 1; } catch (e) { console.log(e.name, e.message); }`,
  },
  {
    id: "b9-file-directive",
    ext: "cjs",
    src: `"use strict";
const s = JSON.parse('"abc"');
try { s[0] = "x"; } catch (e) { console.log(e.name, e.message); }`,
  },
  {
    id: "b9-function-and-class-strict",
    ext: "cjs",
    src: `const u = JSON.parse('"abc"');
function sl() { u.a = 1; console.log("sloppy ok"); }
function st() { "use strict"; try { u.a = 1; } catch (e) { console.log(e.message); } }
class C { m() { try { u.a = 1; } catch (e) { console.log(e.message); } } }
sl(); st(); new C().m();
try { JSON.parse("null").x = 1; } catch (e) { console.log(e.message); }`,
  },
  {
    id: "b10-destructure-text",
    ext: "cjs",
    src: `function t(f) { try { console.log(f()); } catch (e) { console.log(e.name, e.message); } }
const o = {};
t(() => { const { a } = o["p"]; return a; });
t(() => { const { a } = o.p; return a; });
t(() => (function ({ a }) { return a; })(o.x));
t(() => { function f({ a }) { return a; } return f(o.x); });
const d = JSON.parse('{"q":{}}');
t(() => { const { a } = d["q"]["r"]; return a; });
t(() => { const { a } = d[0]; return a; });
const k = "z";
t(() => { const { a } = d[k]; return a; });`,
  },
  {
    id: "b10-destructure-literals",
    ext: "cjs",
    src: `function t(f) { try { console.log(f()); } catch (e) { console.log(e.name, e.message); } }
t(() => { const { a, b } = undefined; });
t(() => { const { a } = null; });`,
  },
  {
    id: "d13-prototype-known-kinds",
    ext: "mjs",
    src: `function has(k, o) { return k in o; }
function fn() {}
const arrow = (a) => a;
const fe = function () {};
async function af() {}
console.log(has("prototype", fn), has("prototype", arrow), has("prototype", fe));
console.log(has("prototype", af));
const own = (o, k) => Object.hasOwn(o, k);
console.log(own(fn, "prototype"), own(arrow, "prototype"));
console.log(has("prototype", (x) => x), has("prototype", function () {}));`,
  },
  {
    id: "d14-x509-reasons",
    ext: "ts",
    src: `import * as crypto from "node:crypto";
for (const b of ["AAAA", "AAAAAAAA", "MAA=", "AgEFAA=="]) {
  try { new crypto.X509Certificate("-----BEGIN CERTIFICATE-----\\n" + b + "\\n-----END CERTIFICATE-----\\n"); } catch (e) { console.log(b, (e as NodeJS.ErrnoException).code, (e as Error).message); }
}`,
  },
  {
    // a method read off a record is a value of unrecorded kind (Node: false)
    id: "d13b-prototype-unknown-kind",
    ext: "mjs",
    src: `function has(k, o) { return k in o; }
const m = { meth() {} };
console.log(has("prototype", m.meth));`,
    fence: {
      stdout: "",
      stderr: "tsinter: unsupported: 'prototype' in or Object.hasOwn on a function held in a dynamic value (whether it is a constructor is not recorded) is not supported yet [SC1090]\n",
    },
  },
  {
    // S119: every conversion that treats a string slot as already a string
    id: "b5-string-conversions",
    ext: "ts",
    src: `const xs: string[] = [];
const u = xs[3];
console.log(String(u), typeof String(u), String(u).length);
console.log(\`\${u}\`, typeof \`\${u}\`, \`\${u}\`.length);
console.log(\`\${xs[1]}\`.length, \`a\${u}\`, \`\${u}b\`);
console.log([u, "a"].join("-"), ["a", u].join(","));
const m = new Map<string, number>(); m.set(u, 1); console.log(m.get(u), m.has("undefined"), m.size, [...m.keys()]);
const r: Record<string, number> = {}; r[u] = 2; console.log(Object.keys(r), r["undefined"]);
console.log(u === undefined, String(u) === "undefined");
const n: number[] = []; console.log(String(n[1]), \`\${n[1]}\`, String(n[1]).length);
const b: boolean[] = []; console.log(String(b[1]), \`\${b[1]}\`);
console.log(String(u).toUpperCase(), \`\${u}\`.toUpperCase());
function f(s: string) { return \`\${s}\`; } console.log(f(u), f(u).length);
function g(s: string) { return String(s); } console.log(g(u), g(u).length);`,
  },
  {
    id: "b6-string-past-end",
    ext: "ts",
    src: `const w = "hello";
let i = 9;
console.log("hello"[9], w[i], w[1], w[-1], typeof w[9], w.at(9), w.at(-9), w.at(1), w.charAt(9) === "", w.charAt(1));
console.log(w[i] === undefined, w[i] ?? "d", \`\${w[i]}\`, w[i] + "x");
try { console.log(w[i].length); } catch (e) { console.log((e as Error).message); }
try { console.log(w[9].length); } catch (e) { console.log((e as Error).message); }
for (let k = 0; k < 7; k++) { const c = w[k]; if (c === undefined) console.log("end", k); }
const s = "a\\u{1F600}";
console.log(s[1].length, s[3], s.length);
const parts = "a,b".split(",");
console.log(parts[0][0], parts[1][5], parts[0][1] === undefined);`,
  },
  {
    // S119 (h): a union operand that holds a string concatenates; the
    // undefined side concatenates against a string
    id: "b7-plus-union-strings",
    ext: "ts",
    src: `const ns: (number | string)[] = [1, "a"];
const b: (boolean | string)[] = [true, "a"];
const vs: (null | string)[] = [null, "s"];
const xs: string[] = [];
const u = xs[1];
console.log(ns[0] + "x", "x" + ns[1], ns[1] + "y", ns[0] + "y", vs[0] + "n", b[0] + "t");
console.log(u + "x", "x" + u, u + vs[1], u + ns[1], u + b[1], ns[1] + u);`,
  },
  {
    id: "b7b-plus-union-number",
    ext: "ts",
    src: `const xs: string[] = [];
const u = xs[1];
const ns: (number | string)[] = [1, "a"];
console.log("before");
try { console.log(u + ns[0]); } catch { console.log("caught"); }`,
    fence: { stdout: "before\n", stderr: PLUS_NAN(5) },
  },
  {
    id: "b7c-plus-union-boolean",
    ext: "ts",
    src: `const xs: string[] = [];
const u = xs[1];
const b: (boolean | string)[] = [true, "a"];
console.log(b[0] + u);`,
    fence: { stdout: "", stderr: PLUS_NAN(4) },
  },
  {
    id: "b7d-plus-union-null",
    ext: "ts",
    src: `const xs: string[] = [];
const u = xs[1];
const vs: (null | string)[] = [null, "s"];
console.log(u + vs[0]);`,
    fence: { stdout: "", stderr: PLUS_NAN(4) },
  },
  {
    id: "b8-optional-chain-stops",
    ext: "ts",
    src: `const ss: string[] = ["a"];
const ls: number[][] = [[1]];
console.log(ss[1]?.trim().length, ls[1]?.slice(1).length, ls[1]?.map((x) => x).length);
console.log(ss[0]?.trim().length, ls[0]?.slice(1).length, ls[0]?.map((x) => x).length);
console.log(ss[1]?.trim().toUpperCase().length, ss[1]?.length, ss[1]?.toUpperCase());
interface R { a: { b: string } }
const rs: R[] = [];
console.log(rs[0]?.a.b.length, rs[0]?.a.b);`,
  },
  {
    id: "c11-writes-arrays",
    ext: "ts",
    src: `function t(f: () => void) { try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
const xs: number[][] = []; const rc: Record<string, number[]> = {};
t(() => { xs[0][0] = 1; });
t(() => { rc["q"][0] = 2; });
const ss: string[][] = [];
t(() => { ss[3][1] = "a"; });
t(() => { ss[3].push("a"); });`,
  },
  {
    id: "c11b-write-record",
    ext: "ts",
    src: `function t(f: () => void) { try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
interface R { a: number; s: string[] }
const rs: R[] = [];
t(() => { rs[0].a = 1; });
const r0 = rs[0];
t(() => { r0.a = 2; });
function set(r: R) { r.a = 3; }
t(() => set(rs[1]));`,
  },
  {
    // a record's field READ on the way to the write is S119 (a)'s fence
    id: "c11d-read-through-record",
    ext: "ts",
    src: `interface R { a: number; s: string[] }
const rs: R[] = [];
try { rs[0].s[1] = "x"; } catch { console.log("caught"); }`,
  },
  {
    id: "c11c-write-class",
    ext: "ts",
    src: `function t(f: () => void) { try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
class K { v = 1; w: string[] = []; }
const ks: K[] = [];
t(() => { ks[0].v = 1; });
const k0 = ks[0];
t(() => { k0.v = 2; });
const a0 = ([] as number[][])[0];
t(() => { a0[2] = 5; });
const key = "zz"; const recs: Record<string, number>[] = [];
t(() => { recs[0][key] = 1; });`,
  },
  {
    // read-modify-writes read first: Node's "Cannot read properties"
    id: "c11e-read-modify-write",
    ext: "ts",
    src: `function t(f: () => void) { try { f(); console.log("ok"); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
class K { v = 1; }
const ks: K[] = [];
const k0 = ks[0];
t(() => { console.log(k0.v++); });`,
  },
  {
    id: "c12-repeat",
    ext: "ts",
    src: `function t(f: () => string) { try { console.log(f().length); } catch (e) { console.log((e as Error).name, (e as Error).message); } }
let n = -1; const inf = Infinity; const big = 2 ** 30;
t(() => "a".repeat(-1)); t(() => "a".repeat(n)); t(() => "a".repeat(inf)); t(() => "a".repeat(-inf));
t(() => "ab".repeat(big)); t(() => "".repeat(big)); t(() => "a".repeat(2.7)); t(() => "a".repeat(NaN)); t(() => "a".repeat(0));
t(() => "".repeat(inf)); t(() => "a".repeat(-0.5)); t(() => "ab".repeat(n + 3)); t(() => "a".repeat(-1.5));`,
  },
  {
    id: "c12b-repeat-dyn",
    ext: "mjs",
    src: `function t(f) { try { console.log(f().length); } catch (e) { console.log(e.name, e.message); } }
function rep(s, c) { return s.repeat(c); }
t(() => rep("a", -1)); t(() => rep("a", "x")); t(() => rep("a", "3")); t(() => rep("a", Infinity)); t(() => rep("ab", 2 ** 30));
t(() => rep("a", null)); t(() => rep("a", undefined)); t(() => rep("a", true));
t(() => "a".repeat("x")); t(() => "a".repeat("2"));`,
  },
];

function expectRow(row: Row, got: Out, node: Out, trapText: string): void {
  if (row.fence === undefined) {
    if (row.fsHost === true) expect({ stdout: got.stdout, exitCode: got.exitCode }).toEqual({ stdout: node.stdout, exitCode: node.exitCode });
    else expect(got).toEqual(node);
    return;
  }
  expect(node.exitCode).toBe(0);
  expect(got.stdout).toBe(row.fence.stdout);
  expect(got.exitCode).toBe(1);
  const stderr = trapText !== "" && got.stderr.endsWith(trapText) ? got.stderr.slice(0, -trapText.length) : got.stderr;
  if (typeof row.fence.stderr === "string") expect(stderr).toBe(row.fence.stderr);
  else expect(stderr).toMatch(row.fence.stderr);
}

describe("the GH #86 review's repros (wasm lane)", () => {
  test.for(ROWS.filter((r) => r.fsHost !== true).map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await wasmRun(id, file, row.fence !== undefined, row.dynamic === true), nodeRun(file), "");
  });
});

describe("the GH #86 review's repros (wasm-native lane)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}-n.${row.ext}`);
    writeFileSync(file, row.src + "\n");
    expectRow(row, await nativeRun(id, file, row.dynamic === true), nodeRun(file), "RuntimeError: unreachable\n");
  }, 600_000);
});

describe("D15: an uncaught DOMException reports as Node prints it", () => {
  test.for(["wasm", "wasm-native"] as const)("%s", async (lane) => {
    const file = join(scratch, `d15-${lane}.mjs`);
    writeFileSync(file, "structuredClone(() => 1);\n");
    const node = nodeRun(file);
    const line = "DOMException [DataCloneError]: () => 1 could not be cloned.";
    expect(node.stderr).toContain(`\n${line}\n`);
    const got = lane === "wasm" ? await wasmRun("d15", file, true) : await nativeRun("d15", file);
    expect(got.exitCode).toBe(1);
    expect(got.stderr.startsWith(`Uncaught ${line}\n`)).toBe(true);
  }, 600_000);
});
