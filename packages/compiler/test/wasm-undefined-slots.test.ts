/* Unit U (Joe's 2026-10-28 ruling; SEMANTICS.md S119, and S003/S006/S032's
 * WasmGC-lane amendments): a typed slot holds `undefined` wherever
 * JavaScript produces one — an array read past the end, destructuring past
 * the end, pop() of an empty array, a missing key of a Record / index
 * signature, a write past the end (holes), a `T | undefined = undefined`
 * default the checker narrows to T, a field read before its first
 * assignment — and every observer answers what Node answers.
 *
 * The C and LLVM lanes keep trapping (their IR is unchanged), so these
 * programs cannot be corpus programs; each row runs here under Node (the
 * oracle, spawned at test time — nothing below is hand-typed output) and
 * on the wasm lane, and the native rows also on the wasm-native lane. The
 * real-app trial's repros (GH #79's four, GH #77, 04b) are rows 01-06. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-unit-u-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  code: number;
}

async function nodeRun(file: string): Promise<Out> {
  const p = run(process.execPath, [file], { encoding: "utf8" });
  p.child.stdin?.end();
  try {
    const r = await p;
    return { stdout: r.stdout, code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; code?: number };
    return { stdout: x.stdout ?? "", code: typeof x.code === "number" ? x.code : -1 };
  }
}

async function wasmRun(id: string, file: string, dynamic: boolean): Promise<Out> {
  const res = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const r = await runWasm(res.binaryPath);
  return { stdout: String(r.stdout), code: r.exitCode };
}

async function nativeRun(id: string, file: string, dynamic: boolean): Promise<Out> {
  const dir = join(scratch, `${id}-native`);
  const res = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", dynamic });
  if (!res.ok) throw new Error(`${id} refused natively: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const p = run(res.binaryPath, [], { encoding: "utf8" });
  p.child.stdin?.end();
  try {
    const r = await p;
    return { stdout: r.stdout, code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; code?: number };
    return { stdout: x.stdout ?? "", code: typeof x.code === "number" ? x.code : -1 };
  }
}

interface Row {
  id: string;
  src: string;
  /** Also on the wasm-native lane (the same module through wasm2c). */
  native?: boolean;
  dynamic?: boolean;
}

const ROWS: Row[] = [
  {
    id: "01-argv-destructure-short",
    native: true,
    src: `const [cmd, a1, a2] = process.argv.slice(2);
console.log("cmd", cmd, "a1", a1, "a2", a2);
console.log(typeof cmd, cmd === undefined, a1 ?? "none", \`[\${a2}]\`);`,
  },
  {
    id: "02-pop-drain-empty",
    src: `type M = { from: number; captured?: string };
class H {
  private hist: M[] = [{ from: 1 }];
  undo(): M | null {
    const o = this.hist.pop();
    return o === undefined ? null : o;
  }
  history(): number[] {
    const rev: (M | null)[] = [];
    while (this.hist.length > 0) rev.push(this.undo());
    const out: number[] = [];
    while (true) {
      const m = rev.pop();
      if (!m) break;
      out.push(m.from);
    }
    return out;
  }
}
console.log(new H().history());
const e: (M | null)[] = [];
console.log(e.pop());
const n: number[] = [];
const p = n.pop();
console.log(p, typeof p, p === undefined, n.length);`,
  },
  {
    id: "03-record-missing-key",
    native: true,
    src: `class C {
  private comments: Record<string, string> = {};
  look(k: string): string {
    const comment = this.comments[k];
    if (typeof comment !== "undefined") return \`has \${comment}\`;
    return "none";
  }
  set(k: string, v: string): void {
    this.comments[k] = v;
  }
}
const c = new C();
console.log(c.look("a"));
c.set("a", "x");
console.log(c.look("a"));
const r: Record<string, string> = {};
const v = r["missing"];
console.log(v === undefined);
const counts: Record<string, number> = {};
for (const w of ["a", "b", "a"]) counts[w] = (counts[w] ?? 0) + 1;
console.log(counts);
const seen: Record<string, boolean> = {};
let fresh = 0;
for (const w of ["a", "b", "a"]) {
  if (!seen[w]) {
    seen[w] = true;
    fresh++;
  }
}
console.log(fresh, seen, seen["zz"]);
type R = { a: number };
const objs: Record<string, R> = {};
const o = objs["nope"];
console.log(o, o === undefined, o?.a);`,
  },
  {
    id: "04-array-grow-write",
    native: true,
    src: `const a: number[] = [];
console.log("before");
a[3] = 7;
console.log(a.length, a[3], a[0]);
console.log(a.join("-"), JSON.stringify(a), a.includes(7), [...a].length);
for (const x of a) console.log(x);
// an out-of-order fill: holes made, then every one filled — exact everywhere
const out: string[] = [];
for (const i of [2, 0, 1]) out[i] = "v" + i;
console.log(out, out.map((s) => s.toUpperCase()));
out.forEach((s, i) => console.log(i, s));`,
  },
  {
    id: "05-param-default-undefined",
    native: true,
    src: `function f(c: string | undefined = undefined): string {
  return c === undefined ? "none" : c;
}
console.log(f(), f("x"));
function g(n: number | undefined = undefined): number {
  return n ?? -1;
}
console.log(g(), g(4));
function dflt(x = 5, y: string = "d"): string {
  return \`\${x}/\${y}\`;
}
const nums: number[] = [];
const strs: string[] = [];
console.log(dflt(nums[9], strs[9]), dflt(1, "z"));`,
  },
  {
    id: "06-optional-field-from-defaulted-param",
    src: `type Move = { from: number; captured?: string };
function viaParam(c: string | undefined): Move {
  return { from: 1, captured: c };
}
console.log(JSON.stringify(viaParam(undefined)));
function viaDefault(c: string | undefined = undefined): Move {
  return { from: 2, captured: c };
}
console.log(JSON.stringify(viaDefault()));
function viaOptionalParam(c?: string): Move {
  return { from: 3, captured: c };
}
console.log(JSON.stringify(viaOptionalParam()));`,
  },
  {
    id: "07-observers-number-string-bool",
    native: true,
    src: `const a: number[] = [1, 2, 3];
const x = a[5];
console.log(x, typeof x, x === undefined, x == null, x + 1, \`\${x}\`, String(x));
const s: string[] = ["a"];
const y = s[3];
console.log(y, typeof y, y === undefined, y ?? "dflt", "p" + y, y || "fallback");
const b: boolean[] = [true];
const z = b[2];
console.log(z, typeof z, !z, z ? "t" : "f", z === true, z === false, \`\${z}\`, z && true, z || "x");
console.log(a[1.5], a[-1], a[a.length]);
console.log(x * 2, x - 1, -x, Math.abs(x), Math.floor(x), Math.max(x, 1), x | 0, ~x, x >>> 0);
console.log(Number.isNaN(x), isNaN(x), Number.isFinite(x), x > 0, x < 0, x === x, x !== x);
console.log(a[5] === a[6], s[5] === s[6], y < "b", y >= "b");
let k = a[7];
const old = k++;
console.log(old, k);
const u: number | string = a[9];
console.log(u, typeof u);
const opt: number | undefined = a[9];
console.log(opt, opt === undefined);
console.log(a.indexOf(2), a.includes(x), [x].includes(x), [x].indexOf(x));`,
  },
  {
    id: "08-composites-print-json",
    src: `const nums: number[] = [10];
const strs: string[] = ["s"];
type Rec = { a: number; b: string; c: boolean };
const recs: Rec[] = [];
const n = nums[3];
const s = strs[3];
const r = recs[0];
const box: Rec = { a: n, b: s, c: [true][4] };
console.log(box);
console.log(JSON.stringify(box), JSON.stringify([n, s]), JSON.stringify({ x: n, y: 1 }));
console.log([n, n], [s, "t"], r);
console.log(r === undefined, typeof r, r ? "yes" : "no", r?.a, s?.length);
if (!r) console.log("no record");
const m = new Map<string, number>();
m.set("x", nums[9]);
console.log(m.get("x"), m.has("x"), m.size);
class A {
  x!: number;
  name!: string;
  constructor(set: boolean) {
    if (set) {
      this.x = 1;
      this.name = "n";
    }
  }
}
const a1 = new A(false);
console.log(a1.x, a1.name, a1);
const rec: Record<string, number> = { p: 1 };
const { p, q } = rec;
const ys: number[] = [];
const [y0 = 5] = ys;
console.log(p, q, y0);`,
  },
  {
    id: "09-member-of-undefined-throws",
    src: `const nums: number[] = [1.5];
const n = nums[4];
try {
  console.log(n.toFixed(2));
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
try {
  console.log(n.toString());
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
const flags: boolean[] = [];
try {
  console.log(flags[0].toString());
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
console.log(nums[0].toFixed(1), String(n));`,
  },
  {
    id: "10-unknown-crossing",
    src: `const nums: number[] = [1];
const u: unknown = nums[4];
console.log(u === undefined, typeof u);
const strs: string[] = [];
const s: unknown = strs[0];
console.log(s === undefined);
const box: unknown = { k: nums[9], m: 2 };
console.log(JSON.stringify(box));`,
  },
  {
    id: "12-unions-without-an-undefined-arm",
    native: true,
    src: `const us: (number | string)[] = [1, "a"];
const w = us[5];
console.log(w, typeof w, w ?? "dflt", w === undefined, w == null);
const pick = (v: number | string): string => (typeof v === "string" ? "s" : typeof v === "number" ? "n" : "u");
console.log(pick(us[7]), pick(us[0]), String(us[9]), \`\${us[9]}\`);
const ns: (number | null)[] = [null];
const m = ns[4];
console.log(m, m === undefined, m === null, m == null, m ?? 3);
const nums: number[] = [];
const x = nums[2];
console.log(-x, -(-x), Math.abs(-x));
type T = { k: number };
const ts: T[] = [];
console.log(ts[3]?.k, [ts[0]]);`,
  },
  {
    id: "13-union-element-holes",
    native: true,
    src: `const u: (string | undefined)[] = [];
u[2] = "x";
for (const x of u) console.log(x, x === undefined, typeof x);
console.log(u.length, u[0] === undefined, u[0] ?? "d", u.join("|"));
const w: (number | string)[] = [];
w[1] = 5;
const first = w[0];
console.log(first === undefined, typeof first, w.length);
const e: (number | undefined)[] = [1, , 3];
console.log(e.length, e[1], e[1] === undefined);
for (const x of e) console.log(x);`,
  },
  // GH review of unit U: each block is one reviewer repro, verbatim.
  {
    id: "20-review-tonumber-toboolean",
    native: true,
    src: "{\nconst xs: number[] = [1];\nconst u = xs[5];\nconst p = Math.sign(u);\nconst q = Math.max(u);\nconst r = Number(u);\nconst s = +u;\nconsole.log(p, q, r, s, [p, q, r, s].map((z) => z === undefined));\nconsole.log(Number(\"abc\"), 0 / 0, Math.abs(-u), Math.abs(u));\n}\n{\nconst xs: number[] = [1];\nconst bs: boolean[] = [];\nconst vals: number[] = [xs[4]];\nconst o = { n: +vals[0] };\nconsole.log(o, JSON.stringify(o));\nconst b2: boolean = Boolean(bs[3]);\nconsole.log(b2, typeof b2);\nconst s2: string = String(xs[3]);\nconsole.log(s2, typeof s2, s2.length);\n}\n{\nconst bs: boolean[] = [];\nconst u = bs[3];\nconsole.log(u === false, u || \"x\", u && \"y\", !u ? 1 : 2, [u].join(\",\"), `${u}`, u == false);\nlet c = 0; if (!u) c++; if (u) c += 10; console.log(c);\nconst n: number = Number(u); console.log(n);\n}\n{\nconst xs: number[] = [1];\nconst u = xs[5];\nconst a = -u;\nconst b = -a;\nconsole.log(a, b, -(-u), b === undefined);\nconst c = -Math.abs(u);\nconsole.log(c, String(c), typeof c);\nconsole.log(+u, Number(u), typeof +u, +u === undefined);\n}\n{\nconst xs: number[] = [1];\nconst u = xs[5];\nconsole.log(Math.max(u), Math.min(u), Math.max(u, 1), Math.min(1, u));\nconsole.log(Math.sign(u), Math.abs(u), Math.floor(u), Math.ceil(u), Math.round(u), Math.trunc(u), Math.sqrt(u), Math.fround(u));\nconsole.log(Math.hypot(u), Math.cbrt(u), Math.pow(u, 1), u ** 1, Math.exp(u));\nconst m = Math.max(u);\nconsole.log(typeof m, m === undefined);\n}",
  },
  {
    id: "21-review-samevalue-map-set",
    native: true,
    src: "{\nconst xs: number[] = [1];\nconst ss: string[] = [];\nconst u = xs[5];\nconst w: number | string = xs[6] as number | string;\nconsole.log(u === xs[7], Object.is(u, xs[8]), Object.is(u, NaN), u == null, u !== u);\nlet un: number | undefined = undefined;\nconsole.log(u === un, un === u);\nconsole.log(ss[0] === undefined, ss[0] == null);\nconst m = new Map<number, string>(); m.set(u, \"a\"); console.log(m.get(xs[9]), m.has(NaN), m.size);\nconst st = new Set<number>([u, NaN, xs[3]]); console.log(st.size, st);\n}\n{\nconst ss: string[] = [\"a\"];\nconst u = ss[4];\nconsole.log(u, u + \"x\", `${u}`, [u, \"b\"].join(\"-\"), JSON.stringify({ k: u }), JSON.stringify([u]));\nconst m = new Map<string, number>(); m.set(u, 1); console.log(m.get(ss[9]), m.has(\"undefined\"), m);\nconst set = new Set<string>([u, \"undefined\"]); console.log(set.size);\nconsole.log(u < \"a\", u > \"a\", u == \"undefined\", u === \"undefined\");\n}\n{\nconst ss: string[] = [\"a\"];\nconst u = ss[4];\nconst m = new Map<string, number>(); m.set(u, 1); console.log(m.get(ss[9]), m.has(\"undefined\"));\nconsole.log(m);\n}",
  },
  {
    id: "22-review-optional-builtin-args",
    src: "{\nconst xs: number[] = [1];\nconst u = xs[5];\nconst a = [1, 2, 3];\nconsole.log(a.slice(0, u), a.slice(u));\n}\n{\nconst xs: number[] = [1];\nconst u = xs[5];\nconst s = \"hello\";\nconsole.log(s.slice(0, u));\n}\n{\nconst xs: number[] = [1];\nconst u = xs[5];\nconsole.log(\"hello\".substring(1, u));\n}\n{\nconst ss: string[] = [];\nconst u = ss[5];\nconst a = [\"p\", \"q\"];\nconsole.log(a.join(u), \"a,b\".split(u), \"hi\".padEnd(5, u) + \"|\", \"xundefinedy\".includes(u), \"xundefinedy\".indexOf(u));\n}",
  },
  {
    id: "23a-review-defaults-fire",
    src: "const xs: number[] = [1];\nfunction f(x: number = 5) { return x; }\nconsole.log(f(xs[10]));\nfunction g(s: string = \"d\") { return s; }\nconst ss: string[] = [];\nconsole.log(g(ss[3]));\nfunction h(b: boolean = true) { return b; }\nconst bs: boolean[] = [];\nconsole.log(h(bs[2]));\nconst [a = 1, c = 2] = xs;\nconsole.log(a, c);\nconst { p = 9 } = { p: xs[4] };\nconsole.log(p);\nconst r: Record<string, number> = {};\nlet q = r[\"x\"]; q ??= 7; console.log(q);",
  },
  {
    id: "23b-review-defaults-fire",
    src: "const xs: number[] = [1];\ntype O = { p: number };\nconst o: O = { p: xs[4] };\nconst { p = 9 } = o;\nfunction g({ p = 4 }: O) { return p; }\nconst [z = 6] = [xs[3]];\nconsole.log(p, g(o), z);",
  },
  {
    id: "24-review-record-json-union-tostring-bytes",
    native: true,
    src: "{\nconst xs: number[] = [1];\nconst r: Record<string, number> = {};\nr[\"a\"] = xs[5];\nconsole.log(r, Object.keys(r), JSON.stringify(r), r.a, r[\"a\"] === undefined);\nconst m = new Map<string, number>(); m.set(\"k\", xs[5]); console.log(m, m.get(\"k\"), m.get(\"zz\"), m.has(\"k\"));\n}\n{\nconst xs: number[] = [1];\nfunction f(u: number | string) {\n  try { console.log(u.toString()); } catch (e) { console.log(\"threw\", (e as Error).message); }\n  try { console.log(String(u), typeof u, `${u}`); } catch (e) { console.log(\"threw2\"); }\n}\nf(xs[9]);\n}\n{\nconst dv = new DataView(new ArrayBuffer(8));\ndv.setUint32(0, 0x64656600, true);\ndv.setUint32(4, 0xfff4756e, true);\nconst v = dv.getFloat64(0, true);\nconsole.log(v, typeof v, v === undefined);\n}",
  },
  {
    id: "11-any-crossing-and-views",
    dynamic: true,
    native: true,
    src: `// @dynamic
const nums: number[] = [1];
const strs: string[] = [];
const a: any = nums[3];
const b: any = strs[2];
console.log(a === undefined, typeof a, b === undefined, typeof b);
type R = { n: number; s: string };
const r: R = { n: nums[5], s: strs[5] };
const v: any = r;
console.log(v.n === undefined, typeof v.s, JSON.stringify(v));
const xs: number[] = [1, 2];
xs[4] = 9;
const ax: any = xs;
console.log(ax.length, ax[2] === undefined);`,
  },
];

describe("unit U: typed slots hold undefined (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, `${row.src}\n`);
    const node = await nodeRun(file);
    expect(node.code).toBe(0);
    const wasm = await wasmRun(id, file, row.dynamic === true);
    expect(wasm.stdout).toBe(node.stdout);
    expect(wasm.code).toBe(node.code);
  });
});

describe("unit U: the same rows on the wasm-native lane", () => {
  test.for(ROWS.filter((r) => r.native === true).map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const file = join(scratch, `${id}.n.ts`);
    writeFileSync(file, `${row.src}\n`);
    const node = await nodeRun(file);
    const native = await nativeRun(id, file, row.dynamic === true);
    expect(native.stdout).toBe(node.stdout);
    expect(native.code).toBe(node.code);
  });
});

/* The loud residue (S119 (b)/(c)): where Node tells a HOLE from undefined
 * — printing, the hole-skipping callbacks, indexOf(undefined) — or sorts
 * undefined last, this tier throws a named, catchable Error. Node's own
 * answer is shown beside each row's expectation. */
describe("unit U: the hole and sort fences are loud and named", () => {
  const fenced = async (id: string, src: string): Promise<string> => {
    const file = join(scratch, `${id}.ts`);
    writeFileSync(file, `${src}\n`);
    const r = await wasmRun(id, file, false);
    expect(r.code).toBe(0);
    return r.stdout;
  };
  test("printing / forEach / map / indexOf(undefined) over an array that still holds a hole", async () => {
    // Node: [ <3 empty items>, 7 ]; forEach visits 7 only; map keeps the holes.
    const out = await fenced(
      "f1",
      `const a: number[] = [];
a[3] = 7;
const tries: [string, () => void][] = [
  ["print", () => console.log(a)],
  ["forEach", () => a.forEach((x) => console.log(x))],
  ["map", () => console.log(a.map((x) => x + 1).length)],
  ["indexOf", () => console.log(a.indexOf(a[0]))],
];
for (const [what, f] of tries) {
  try {
    f();
    console.log(what, "ran");
  } catch (e) {
    console.log(what, (e as Error).message.split(" over ")[0]);
  }
}
console.log(a.indexOf(7));`,
    );
    expect(out).toBe(
      "print printing (util.inspect)\nforEach Array.prototype.forEach\nmap Array.prototype.map\nindexOf Array.prototype.indexOf\n3\n",
    );
  });
  test("GH #85: an elision is a hole — forEach and map over [1, , 3] are fenced, not run over the hole", async () => {
    // Node: forEach prints `0 1` and `2 3`; map answers [ 2, <1 empty item>, 6 ].
    const out = await fenced(
      "f85",
      `const a: (number | undefined)[] = [1, , 3];
try {
  a.forEach((v, i) => console.log(i, v));
} catch (e) {
  console.log((e as Error).message.split(" over ")[0]);
}
try {
  console.log(a.map((v) => (v ?? 0) * 2));
} catch (e) {
  console.log((e as Error).message.split(" over ")[0]);
}
console.log(a.length, a[1]);`,
    );
    expect(out).toBe("Array.prototype.forEach\nArray.prototype.map\n3 undefined\n");
  });
  test("the 'in' operator and for-in over an array that holds a hole", async () => {
    // Node: `0 in a` is false and for-in visits 3 only.
    const out = await fenced(
      "fin",
      `const a: number[] = [];
a[3] = 7;
try {
  console.log(0 in a);
} catch (e) {
  console.log((e as Error).message.split(" over ")[0]);
}
try {
  for (const k in a) console.log(k);
} catch (e) {
  console.log((e as Error).message.split(" over ")[0]);
}`,
    );
    expect(out).toBe("the 'in' operator\nfor-in\n");
  });
  test("structuredClone of a value holding a plain-typed undefined throws the checked crossing's TypeError (S119 (g))", async () => {
    // Node: { a: undefined, s: 'x' }.
    const out = await fenced(
      "fsc",
      `const xs: number[] = [1];
interface P { a: number; s: string }
const o: P = { a: xs[3], s: "x" };
try {
  console.log(structuredClone(o));
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}`,
    );
    expect(out).toBe("TypeError expected number at $.a, got undefined\n");
  });
  test("a program that never made a hole prints its explicit undefineds (no fence)", async () => {
    const out = await fenced(
      "f2",
      `const xs: number[] = [1];
const ys: number[] = [xs[5], 2];
console.log(ys);
ys.forEach((y) => console.log(y));`,
    );
    expect(out).toBe("[ undefined, 2 ]\nundefined\n2\n");
  });
  test("sort over a plain-typed array holding undefined", async () => {
    // Node: [ 1, 2, undefined ] — undefined last, the comparator never sees it.
    const out = await fenced(
      "f3",
      `const xs: number[] = [2, 1];
xs.push(xs[9]);
try {
  xs.sort((a, b) => a - b);
} catch (e) {
  console.log((e as Error).message.split(" (")[0]);
}`,
    );
    expect(out).toBe("Array.prototype.sort over an array holding undefined\n");
  });
});
